// Ported from krisv/ai-grid-cloud-provider-poc src/app/__tests__/tenants.test.tsx at 62319b8.
// The PoC drives its Git-backed API; here the same cases run on MockConsoleService, and the
// BFF and fake backend rules are covered by bff/internal/api and bff/internal/fakebackend tests.
// Rulings: the localStorage persistence case keeps only its stale-version assertions (D3), and
// the "name matches the create route" case opens an organization named create by id (D2).
import { screen, waitFor, within } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { ServiceError } from '../api/ConsoleService';
import { HttpConsoleService } from '../api/HttpConsoleService';
import { MockConsoleService } from '../api/MockConsoleService';
import type { OrganizationInput } from '../api/types';
import { renderAt } from './render';

const input: OrganizationInput = {
  name: 'tenant1',
  domains: ['tenant1.example.com'],
  identityProvider: {
    title: 'Tenant 1 SSO',
    description: 'SSO configuration',
    enabled: true,
    config: {
      clientId: 'tenant1-client',
      clientSecretSecret: { name: 'tenant1-secret' },
      issuer: 'https://sso.example.com/tenant1',
      authorizationUrl: 'https://sso.example.com/auth',
      tokenUrl: 'https://sso.example.com/token',
      defaultScopes: 'openid profile email',
      userInfoUrl: '',
      jwksUrl: '',
      logoutUrl: '',
      validateSignature: true,
    },
  },
};

const emptyService = () => new MockConsoleService(undefined, undefined, []);
const viewer = { username: 'viewer', groups: [], isProviderAdmin: false };

const fillRequiredIdp = async (user: ReturnType<typeof userEvent.setup>, values: [string, string][]) => {
  for (const [label, value] of values) {
    await user.type(screen.getByRole('textbox', { name: label }), value);
  }
};

const requiredIdp: [string, string][] = [
  ['Client ID', 'client'],
  ['Client secret reference', 'secret'],
  ['Issuer', 'https://idp.example.com'],
  ['Authorization URL', 'https://idp.example.com/auth'],
  ['Token URL', 'https://idp.example.com/token'],
];

it('onboards organization details then IdP, saves only after review, supports details/edit/delete and orders navigation', async () => {
  const service = emptyService();
  const user = userEvent.setup();
  renderAt('/organizations', service);
  expect(await screen.findByRole('heading', { name: 'Organizations' })).toBeVisible();
  const nav = screen.getByRole('navigation', { name: 'Console sections' });
  expect(
    within(nav)
      .getAllByRole('link')
      .map((link) => link.textContent),
  ).toEqual(['AI Grid', 'Monitoring', 'Clusters', 'Organizations', 'Models', 'Subscriptions']);
  await user.click(await screen.findByRole('link', { name: 'Create organization' }));
  const name = await screen.findByRole('textbox', { name: 'Name' });
  expect(screen.getByRole('button', { name: 'Next' })).toBeDisabled();
  await user.type(name, 'tenant1');
  await user.click(screen.getByRole('button', { name: 'Add domain' }));
  await user.type(screen.getByRole('textbox', { name: 'Domain 1' }), 'tenant1.example.com');
  await user.click(screen.getByRole('button', { name: 'Add domain' }));
  await user.click(screen.getByRole('button', { name: 'Remove domain 2' }));
  await user.click(screen.getByRole('button', { name: 'Next' }));
  expect(screen.getByRole('button', { name: 'Next' })).toBeDisabled();
  expect(await service.listOrganizations()).toEqual([]);
  await fillRequiredIdp(user, [
    ['Title', 'Tenant 1 SSO'],
    ['Client ID', 'tenant1-client'],
    ['Client secret reference', 'tenant1-secret'],
    ['Issuer', 'https://sso.example.com/tenant1'],
    ['Authorization URL', 'https://sso.example.com/auth'],
    ['Token URL', 'https://sso.example.com/token'],
  ]);
  await user.click(screen.getByRole('button', { name: 'Next' }));
  expect(screen.getByTestId('tenant-configuration-details')).toHaveTextContent('tenant1.example.com');
  expect(screen.getByTestId('tenant-configuration-details')).toHaveTextContent('Tenant 1 SSO');
  expect(screen.queryByText(/break.glass/i)).not.toBeInTheDocument();
  await user.click(screen.getByRole('button', { name: 'Create organization' }));
  const table = await screen.findByTestId('tenants-table');
  expect(table).toHaveTextContent('Saved');
  expect(table).toHaveTextContent('tenant1.example.com');
  expect(await screen.findByText('Organization and identity provider saved')).toBeVisible();
  expect(service.organizations[0].identityProvider?.config.clientSecretSecret.name).toBe('tenant1-secret');
  await user.click(within(table).getByRole('link', { name: 'tenant1' }));
  expect(await screen.findByTestId('tenant-configuration-details')).toHaveTextContent(
    'https://sso.example.com/tenant1',
  );
  await user.click(screen.getByRole('link', { name: 'Edit organization' }));
  expect(await screen.findByRole('textbox', { name: 'Name' })).toBeDisabled();
  await user.click(screen.getByRole('button', { name: 'Next' }));
  const title = screen.getByRole('textbox', { name: 'Title' });
  await user.clear(title);
  await user.type(title, 'Updated SSO');
  await user.click(screen.getByRole('button', { name: 'Next' }));
  await user.click(screen.getByRole('button', { name: 'Save changes' }));
  expect(await screen.findByTestId('tenants-table')).toHaveTextContent('Updated SSO');
  expect(await screen.findByText('Organization configuration saved')).toBeVisible();
  await user.click(screen.getByTestId('tenant-actions-tenant1'));
  await user.click(screen.getByRole('menuitem', { name: 'Delete' }));
  const modal = await screen.findByTestId('delete-tenant-modal');
  expect(modal).toHaveTextContent('Delete organization?');
  expect(modal).toHaveTextContent('Delete this organization and its saved identity provider configuration?');
  await user.type(within(modal).getByTestId('delete-modal-input'), 'tenant1');
  await user.click(within(modal).getByRole('button', { name: 'Delete' }));
  await waitFor(() => expect(screen.queryByTestId('tenants-table')).not.toBeInTheDocument());
  expect(await service.listOrganizations()).toEqual([]);
}, 15000);

it('keeps onboarding input on conflicts and allows cancel without saving', async () => {
  const service = emptyService();
  await service.createOrganization(input);
  const user = userEvent.setup();
  renderAt('/organizations/create', service);
  await user.type(await screen.findByRole('textbox', { name: 'Name' }), 'tenant1');
  await user.click(screen.getByRole('button', { name: 'Next' }));
  await fillRequiredIdp(user, requiredIdp);
  await user.click(screen.getByRole('button', { name: 'Next' }));
  await user.click(screen.getByRole('button', { name: 'Create organization' }));
  expect(await screen.findByText('An organization with this name already exists.')).toBeVisible();
  expect(screen.getByTestId('tenant-configuration-details')).toHaveTextContent('tenant1');
  await user.click(screen.getByRole('button', { name: 'Cancel' }));
  expect(await screen.findByTestId('tenants-table')).toHaveTextContent('Tenant 1 SSO');
  expect(await service.listOrganizations()).toHaveLength(1);
});

it('protects edits from stale versions', async () => {
  const service = emptyService();
  const organization = await service.createOrganization(input);
  expect(await service.getOrganization(organization.id)).toEqual(organization);
  const next = await service.updateOrganization(
    organization.id,
    { ...input, domains: [] },
    organization.resourceVersion,
  );
  const stale = {
    status: 409,
    message: `object with identifier '${organization.id}' has resource version 2, the request carries "1"; fetch it again and retry`,
  };
  await expect(service.updateOrganization(organization.id, input, organization.resourceVersion)).rejects.toMatchObject(
    stale,
  );
  await expect(service.deleteOrganization(organization.id, organization.resourceVersion)).rejects.toMatchObject(stale);
  await service.deleteOrganization(organization.id, next.resourceVersion);
  expect(await service.listOrganizations()).toEqual([]);
});

it('shows a retry action when organization loading fails', async () => {
  const service = emptyService();
  const list = service.listOrganizations;
  service.listOrganizations = async () => {
    service.listOrganizations = list;
    throw new ServiceError(503, 'Organization service unavailable.');
  };
  const user = userEvent.setup();
  renderAt('/organizations', service);
  expect(await screen.findByText('Organization service unavailable.')).toBeVisible();
  await user.click(screen.getByRole('button', { name: 'Retry' }));
  expect(await screen.findByText('No organizations yet. Register one to get started.')).toBeVisible();
});

it('an organization named create opens its details by id', async () => {
  const service = emptyService();
  const created = await service.createOrganization({ ...input, name: 'create', domains: [] });
  const user = userEvent.setup();
  renderAt('/organizations', service);
  const table = await screen.findByTestId('tenants-table');
  const link = within(table).getByRole('link', { name: 'create' });
  expect(link).toHaveAttribute('href', `/organizations/${created.id}`);
  await user.click(link);
  expect(await screen.findByTestId('tenant-configuration-details')).toHaveTextContent('Tenant 1 SSO');
  expect(screen.queryByRole('textbox', { name: 'Name' })).not.toBeInTheDocument();
});

it.each(['create', 'edit'])('Back returns from %s to the organization list without saving', async (mode) => {
  const service = emptyService();
  const existing = await service.createOrganization(input);
  const user = userEvent.setup();
  renderAt(mode === 'create' ? '/organizations/create' : `/organizations/${existing.id}/edit`, service);
  const name = await screen.findByRole('textbox', { name: 'Name' });
  if (mode === 'create') await user.type(name, 'unsaved-tenant');
  await user.click(screen.getByRole('button', { name: 'Next' }));
  const title = screen.getByRole('textbox', { name: 'Title' });
  await user.clear(title);
  await user.type(title, 'Unsaved IdP');
  await user.click(screen.getByRole('button', { name: 'Back' }));
  expect(screen.getByRole('textbox', { name: 'Name' })).toHaveValue(mode === 'create' ? 'unsaved-tenant' : 'tenant1');
  await user.click(screen.getByRole('button', { name: 'Back' }));
  expect(await screen.findByTestId('tenants-table')).toHaveTextContent('Tenant 1 SSO');
  expect(await service.listOrganizations()).toEqual([existing]);
});

it('keeps input on conflict', async () => {
  const service = emptyService();
  const existing = await service.createOrganization(input);
  const user = userEvent.setup();
  renderAt(`/organizations/${existing.id}/edit`, service);
  await user.click(await screen.findByRole('button', { name: 'Next' }));
  const title = screen.getByRole('textbox', { name: 'Title' });
  await user.clear(title);
  await user.type(title, 'My unsaved title');
  await user.click(screen.getByRole('button', { name: 'Next' }));
  // Another tab saves first, so the version this form read is stale.
  await service.updateOrganization(existing.id, input, existing.resourceVersion);
  await user.click(screen.getByRole('button', { name: 'Save changes' }));
  // The PoC's message, not the backend's text.
  expect(await screen.findByText('This organization changed. Reload it before saving or deleting.')).toBeVisible();
  expect(screen.getByText('Unable to save organization')).toBeVisible();
  expect(screen.getByTestId('tenant-configuration-details')).toHaveTextContent('My unsaved title');
  expect(screen.getByRole('button', { name: 'Save changes' })).toBeEnabled();
  expect(service.organizations[0].identityProvider?.title).toBe('Tenant 1 SSO');
  expect(service.organizations[0].resourceVersion).toBe('2');
});

it('hides write actions from a viewer', async () => {
  const service = new MockConsoleService(viewer);
  const list = renderAt('/organizations', service);
  await waitFor(() => expect(screen.getByTestId('masthead-user')).toHaveTextContent('viewer'));
  const table = await screen.findByTestId('tenants-table');
  expect(within(table).getByRole('link', { name: 'acme-robotics' })).toBeInTheDocument();
  expect(screen.queryByRole('link', { name: 'Create organization' })).not.toBeInTheDocument();
  expect(screen.queryByTestId('tenant-actions-acme-robotics')).not.toBeInTheDocument();

  list.unmount();

  renderAt(`/organizations/${service.organizations[0].id}`, service);
  await waitFor(() => expect(screen.getByTestId('masthead-user')).toHaveTextContent('viewer'));
  expect(await screen.findByRole('heading', { name: 'acme-robotics' })).toBeInTheDocument();
  expect(screen.queryByRole('link', { name: 'Edit organization' })).not.toBeInTheDocument();
});

it('shows field errors from the server next to the field', async () => {
  const service = emptyService();
  service.createOrganization = async () => {
    throw new ServiceError(422, 'The organization is invalid.', {
      'identityProvider.config.issuer': 'Enter a valid HTTP or HTTPS URL.',
    });
  };
  const user = userEvent.setup();
  renderAt('/organizations/create', service);
  await user.type(await screen.findByRole('textbox', { name: 'Name' }), 'tenant1');
  await user.click(screen.getByRole('button', { name: 'Next' }));
  await fillRequiredIdp(user, requiredIdp);
  await user.click(screen.getByRole('button', { name: 'Next' }));
  await user.click(screen.getByRole('button', { name: 'Create organization' }));
  expect(await screen.findByText('The organization is invalid.')).toBeVisible();
  await user.click(screen.getByRole('button', { name: 'Back' }));
  const issuer = screen.getByRole('textbox', { name: 'Issuer' });
  expect(issuer).toHaveAttribute('aria-invalid', 'true');
  expect(screen.getByText('Enter a valid HTTP or HTTPS URL.')).toBeVisible();
  // Editing the field clears the server's message for it.
  await user.type(issuer, '/realms/x');
  expect(issuer).toHaveAttribute('aria-invalid', 'false');
  expect(screen.queryByText('Enter a valid HTTP or HTTPS URL.')).not.toBeInTheDocument();
});

it('shows the not-available state when the backend cannot delete organizations yet', async () => {
  const service = new MockConsoleService();
  service.deleteOrganization = async () => {
    throw new ServiceError(501, 'the AI Grid backend does not support this operation yet');
  };
  const user = userEvent.setup();
  renderAt('/organizations', service);
  await user.click(await screen.findByTestId('tenant-actions-initech-labs'));
  await user.click(screen.getByRole('menuitem', { name: 'Delete' }));
  const modal = await screen.findByTestId('delete-tenant-modal');
  await user.type(within(modal).getByTestId('delete-modal-input'), 'initech-labs');
  await user.click(within(modal).getByRole('button', { name: 'Delete' }));
  expect(await within(modal).findByText('Deleting organizations is not available on this backend yet.')).toBeVisible();
  expect(within(modal).queryByText('the AI Grid backend does not support this operation yet')).not.toBeInTheDocument();
});

it('paginates the list like the PoC', async () => {
  renderAt('/organizations', new MockConsoleService());
  expect(await screen.findByTestId('tenants-table')).toBeVisible();
  expect(screen.getAllByRole('navigation', { name: /pagination/i })).toHaveLength(2);
});

// PR 12's tenant JSON, as GET /api/v1/tenants/{id} sends it (mock/examples/get-tenant.json), trimmed.
const tenantJson = {
  id: '3f1c9a72-5b6e-4d2a-8c01-2d3e4f5a6b7c',
  name: 'acme-robotics',
  alias: 'acme-robotics',
  enabled: true,
  description: 'Acme Robotics, EU region',
  domains: ['acme-robotics.example.com'],
  domainDetails: [{ name: 'acme-robotics.example.com', verified: true, autoRedirect: true }],
  attributes: { 'billing-account': 'ACME-0042' },
  resourceVersion: '3',
  createTime: '2026-09-01T09:00:00Z',
  identityProvider: { ...input.identityProvider, title: 'Acme SSO' },
};

const jsonResponse = (status: number, body: unknown) =>
  new Response(JSON.stringify(body), { status, headers: { 'Content-Type': 'application/json' } });

/** A MockConsoleService whose organization calls go through HttpConsoleService to fetchFn. */
const serviceOnTenantJson = (fetchFn: typeof fetch) => {
  const service = new MockConsoleService();
  const http = new HttpConsoleService(fetchFn);
  service.listOrganizations = () => http.listOrganizations();
  service.getOrganization = (id) => http.getOrganization(id);
  service.updateOrganization = (id, value, version) => http.updateOrganization(id, value, version);
  return service;
};

it('edit sends PATCH with domains, identity provider, and If-Match', async () => {
  const fetchFn = vi.fn(async (url: string, _init?: RequestInit) =>
    jsonResponse(200, { data: url.endsWith('/tenants') ? [tenantJson] : tenantJson }),
  );
  const user = userEvent.setup();
  renderAt(`/organizations/${tenantJson.id}/edit`, serviceOnTenantJson(fetchFn as unknown as typeof fetch));
  const domain = await screen.findByRole('textbox', { name: 'Domain 1' });
  await waitFor(() => expect(domain).toHaveValue('acme-robotics.example.com'));
  await user.clear(domain);
  await user.type(domain, 'acme.example.net');
  await user.click(screen.getByRole('button', { name: 'Next' }));
  await user.click(screen.getByRole('button', { name: 'Next' }));
  await user.click(screen.getByRole('button', { name: 'Save changes' }));
  expect(await screen.findByText('Organization configuration saved')).toBeVisible();

  const patch = fetchFn.mock.calls.find(([, init]) => init?.method === 'PATCH');
  expect(patch?.[0]).toBe(`/api/v1/tenants/${tenantJson.id}`);
  expect(patch?.[1]?.headers).toMatchObject({ 'If-Match': '"3"', 'Content-Type': 'application/json' });
  // The PoC can't rename, and alias, description, and attributes have no inputs: only these two go.
  expect(JSON.parse(String(patch?.[1]?.body))).toEqual({
    domains: ['acme.example.net'],
    identityProvider: { ...input.identityProvider, title: 'Acme SSO' },
  });
});

it('shows the registered date, a dash without one, and Disabled for a disabled organization', async () => {
  const fetchFn = vi.fn(async () =>
    jsonResponse(200, {
      data: [
        tenantJson,
        {
          ...tenantJson,
          id: 'u',
          name: 'umbrella-biotech',
          enabled: false,
          createTime: undefined,
          identityProvider: undefined,
        },
      ],
    }),
  );
  renderAt('/organizations', serviceOnTenantJson(fetchFn as unknown as typeof fetch));
  const acme = await screen.findByRole('row', { name: /^acme-robotics / });
  expect(acme).toHaveTextContent(new Date('2026-09-01T09:00:00Z').toLocaleString());
  expect(within(acme).getByText('Saved')).toBeInTheDocument();
  expect(acme).toHaveTextContent('Acme SSO');
  const umbrella = screen.getByRole('row', { name: /^umbrella-biotech / });
  expect(within(umbrella).getByText('Disabled')).toBeInTheDocument();
  expect(within(umbrella).getAllByText('—')).toHaveLength(2);
});
