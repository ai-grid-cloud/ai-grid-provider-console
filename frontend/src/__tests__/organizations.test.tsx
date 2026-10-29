// Ported from krisv/ai-grid-cloud-provider-poc src/app/__tests__/tenants.test.tsx at 62319b8.
// The PoC drives its Git-backed API; here the same cases run on MockConsoleService, and the
// BFF and fake backend rules are covered by bff/internal/api and bff/internal/fakebackend tests.
// Rulings: the localStorage persistence case keeps only its stale-version assertions (D3), and
// the "name matches the create route" case opens an organization named create by id (D2).
import { act, render, screen, waitFor, within } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { MemoryRouter, useNavigate } from 'react-router-dom';
import type { NavigateFunction } from 'react-router-dom';
import { ServiceError } from '../api/ConsoleService';
import { HttpConsoleService } from '../api/HttpConsoleService';
import { MockConsoleService } from '../api/MockConsoleService';
import type { Organization, OrganizationInput } from '../api/types';
import { deferred, renderAt } from './render';
// The routes load these pages lazily; loaded here, their import does not run inside a test's findBy.
import '../pages/organizations/OrganizationDetailsPage';
import '../pages/organizations/OrganizationListPage';
import '../pages/organizations/OrganizationWizardPage';
import { TestApp } from './TestApp';

const input: Required<OrganizationInput> = {
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

type User = ReturnType<typeof userEvent.setup>;

/** Opens an edit wizard step from its navigation: every step is open from the start when editing. */
const openStep = async (user: User, name: 'Organization details' | 'Identity provider' | 'Review') =>
  user.click(await screen.findByRole('button', { name }));

/** Opens Review and saves the edit. */
const saveEdit = async (user: User) => {
  await openStep(user, 'Review');
  await user.click(screen.getByRole('button', { name: 'Save changes' }));
};
/** A user the console couldn't load: the pages show, but without write actions. A viewer
 * (isProviderAdmin false) sees no pages at all (App.test.tsx). */
const unknownUser = () => {
  const service = new MockConsoleService();
  service.getUser = () => Promise.reject(new ServiceError(500, 'unavailable'));
  return service;
};

const fillRequiredIdp = async (user: ReturnType<typeof userEvent.setup>, values: [string, string][]) => {
  for (const [label, value] of values) {
    await user.click(screen.getByRole('textbox', { name: label }));
    await user.paste(value);
  }
};

const requiredIdp: [string, string][] = [
  ['Client ID', 'client'],
  ['Client secret reference', 'secret'],
  ['Issuer', 'https://idp.example.com'],
  ['Authorization URL', 'https://idp.example.com/auth'],
  ['Token URL', 'https://idp.example.com/token'],
];

it('onboards organization details then IdP, saves only after review and orders navigation', async () => {
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
  await user.click(name);
  await user.paste('tenant1');
  await user.click(screen.getByRole('button', { name: 'Add domain' }));
  await user.click(screen.getByRole('textbox', { name: 'Domain 1' }));
  await user.paste('tenant1.example.com');
  await user.click(screen.getByRole('button', { name: 'Add domain' }));
  await user.click(screen.getByRole('button', { name: 'Remove domain 2' }));
  await user.click(screen.getByRole('button', { name: 'Next' }));
  // A blank identity provider is optional; a partly filled one isn't.
  expect(screen.getByRole('button', { name: 'Next' })).toBeEnabled();
  await user.click(screen.getByRole('textbox', { name: 'Title' }));
  await user.paste('Tenant 1 SSO');
  expect(screen.getByRole('button', { name: 'Next' })).toBeDisabled();
  expect(await service.listOrganizations()).toEqual([]);
  await fillRequiredIdp(user, [
    ['Client ID', 'tenant1-client'],
    ['Client secret reference', 'tenant1-secret'],
    ['Issuer', 'https://sso.example.com/tenant1'],
    ['Authorization URL', 'https://sso.example.com/auth'],
    ['Token URL', 'https://sso.example.com/token'],
  ]);
  await user.click(screen.getByRole('button', { name: 'Next' }));
  const review = screen.getByTestId('organization-configuration-details');
  expect(review).toHaveTextContent('tenant1.example.com');
  expect(review).toHaveTextContent('Tenant 1 SSO');
  // Empty optional fields are left out of the review.
  expect(review).not.toHaveTextContent('User info URL');
  expect(screen.queryByText(/break.glass/i)).not.toBeInTheDocument();
  // Each section's Edit link goes back to its step.
  await user.click(screen.getByRole('button', { name: 'Edit identity provider' }));
  expect(screen.getByRole('textbox', { name: 'Title' })).toHaveValue('Tenant 1 SSO');
  await user.click(screen.getByRole('button', { name: 'Next' }));
  await user.click(screen.getByRole('button', { name: 'Create organization' }));
  const table = await screen.findByTestId('organizations-table');
  expect(table).toHaveTextContent('Enabled');
  expect(table).toHaveTextContent('tenant1.example.com');
  expect(await screen.findByText('Organization created')).toBeVisible();
  expect(service.organizations[0].identityProvider?.config.clientSecretSecret.name).toBe('tenant1-secret');
});

it('opens an organization from the list and edits its identity provider', async () => {
  const service = emptyService();
  await service.createOrganization(input);
  const user = userEvent.setup();
  renderAt('/organizations', service);
  const table = await screen.findByTestId('organizations-table');
  await user.click(within(table).getByRole('link', { name: 'tenant1' }));
  expect(await screen.findByTestId('organization-configuration-details')).toHaveTextContent(
    'https://sso.example.com/tenant1',
  );
  expect(screen.getByRole('heading', { name: 'tenant1' })).toBeVisible();
  await user.click(screen.getByTestId('organization-actions'));
  await user.click(screen.getByRole('menuitem', { name: 'Edit' }));
  // Edit is the create wizard with every step open; the name can't change, so it's read-only.
  expect(await screen.findByRole('heading', { name: 'Edit tenant1' })).toBeVisible();
  expect(screen.getByRole('textbox', { name: 'Name' })).toHaveAttribute('readonly');
  expect(screen.getByText('The name cannot be edited after the organization is created.')).toBeVisible();
  // Nothing changed yet, so Review can't save.
  await openStep(user, 'Review');
  expect(screen.getByRole('button', { name: 'Save changes' })).toBeDisabled();
  await openStep(user, 'Identity provider');
  const title = screen.getByRole('textbox', { name: 'Title' });
  await user.clear(title);
  await user.paste('Updated SSO');
  await saveEdit(user);
  expect(await screen.findByText('Organization updated')).toBeVisible();
  expect(await screen.findByTestId('organization-configuration-details')).toHaveTextContent('Updated SSO');
});

it('deletes an organization from its page after its name is typed', async () => {
  const service = emptyService();
  await service.createOrganization(input);
  const user = userEvent.setup();
  renderAt('/organizations', service);
  await user.click(within(await screen.findByTestId('organizations-table')).getByRole('link', { name: 'tenant1' }));
  expect(await screen.findByRole('heading', { name: 'tenant1' })).toBeVisible();
  await user.click(screen.getByTestId('organization-actions'));
  await user.click(screen.getByRole('menuitem', { name: 'Delete' }));
  const modal = await screen.findByTestId('delete-organization-modal');
  expect(modal).toHaveTextContent('Delete organization?');
  expect(modal).toHaveTextContent('The organization and its identity provider configuration will be deleted.');
  await user.click(within(modal).getByTestId('delete-modal-input'));
  await user.paste('tenant1');
  await user.click(within(modal).getByRole('button', { name: 'Delete' }));
  expect(await screen.findByText('Organization deleted')).toBeVisible();
  // The list reloads after the delete; the toast can show before it does.
  expect(await screen.findByRole('heading', { name: 'No organizations' })).toBeVisible();
  expect(await service.listOrganizations()).toEqual([]);
});

it('keeps onboarding input on conflicts and allows cancel without saving', async () => {
  const service = emptyService();
  await service.createOrganization(input);
  const user = userEvent.setup();
  renderAt('/organizations/create', service);
  await user.click(await screen.findByRole('textbox', { name: 'Name' }));
  await user.paste('tenant1');
  await user.click(screen.getByRole('button', { name: 'Next' }));
  await fillRequiredIdp(user, requiredIdp);
  await user.click(screen.getByRole('button', { name: 'Next' }));
  await user.click(screen.getByRole('button', { name: 'Create organization' }));
  expect(await screen.findByText('An organization with this name already exists.')).toBeVisible();
  expect(screen.getByTestId('organization-configuration-details')).toHaveTextContent('tenant1');
  await user.click(screen.getByRole('button', { name: 'Cancel' }));
  await user.click(within(await screen.findByTestId('discard-changes-modal')).getByRole('button', { name: 'Discard' }));
  expect(await screen.findByTestId('organizations-table')).toHaveTextContent('Tenant 1 SSO');
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
  expect(await screen.findByRole('heading', { name: 'No organizations' })).toBeVisible();
});

it('an organization named create opens its details by id', async () => {
  const service = emptyService();
  const created = await service.createOrganization({ ...input, name: 'create', domains: [] });
  const user = userEvent.setup();
  renderAt('/organizations', service);
  const table = await screen.findByTestId('organizations-table');
  const link = within(table).getByRole('link', { name: 'create' });
  expect(link).toHaveAttribute('href', `/organizations/${created.id}`);
  await user.click(link);
  expect(await screen.findByTestId('organization-configuration-details')).toHaveTextContent('Tenant 1 SSO');
  expect(screen.queryByRole('textbox', { name: 'Name' })).not.toBeInTheDocument();
});

it('create: Back keeps input, and Cancel asks before discarding it', async () => {
  const service = emptyService();
  const existing = await service.createOrganization(input);
  const user = userEvent.setup();
  renderAt('/organizations/create', service);
  await user.click(await screen.findByRole('textbox', { name: 'Name' }));
  await user.paste('unsaved-tenant');
  expect(screen.getByRole('button', { name: 'Back' })).toBeDisabled();
  await user.click(screen.getByRole('button', { name: 'Next' }));
  await user.click(screen.getByRole('textbox', { name: 'Title' }));
  await user.paste('Unsaved IdP');
  await user.click(screen.getByRole('button', { name: 'Back' }));
  expect(screen.getByRole('textbox', { name: 'Name' })).toHaveValue('unsaved-tenant');
  await user.click(screen.getByRole('button', { name: 'Cancel' }));
  const discard = await screen.findByTestId('discard-changes-modal');
  await user.click(within(discard).getByRole('button', { name: 'Keep editing' }));
  expect(screen.getByRole('textbox', { name: 'Name' })).toHaveValue('unsaved-tenant');
  await user.click(screen.getByRole('button', { name: 'Cancel' }));
  await user.click(within(await screen.findByTestId('discard-changes-modal')).getByRole('button', { name: 'Discard' }));
  expect(await screen.findByTestId('organizations-table')).toHaveTextContent('Tenant 1 SSO');
  expect(await service.listOrganizations()).toEqual([existing]);
});

it('edit: Cancel leaves at once without changes, and returns to the organization after discarding', async () => {
  const service = emptyService();
  const existing = await service.createOrganization(input);
  const user = userEvent.setup();
  renderAt(`/organizations/${existing.id}/edit`, service);
  await user.click(await screen.findByRole('button', { name: 'Cancel' }));
  expect(await screen.findByTestId('organization-configuration-details')).toBeVisible();
  expect(screen.queryByTestId('discard-changes-modal')).not.toBeInTheDocument();

  await user.click(screen.getByTestId('organization-actions'));
  await user.click(screen.getByRole('menuitem', { name: 'Edit' }));
  await openStep(user, 'Identity provider');
  const title = await screen.findByRole('textbox', { name: 'Title' });
  await user.clear(title);
  await user.paste('Unsaved IdP');
  await user.click(screen.getByRole('button', { name: 'Cancel' }));
  await user.click(within(await screen.findByTestId('discard-changes-modal')).getByRole('button', { name: 'Discard' }));
  expect(await screen.findByTestId('organization-configuration-details')).toHaveTextContent('Tenant 1 SSO');
  expect(await service.listOrganizations()).toEqual([existing]);
});

it('keeps input on conflict', async () => {
  const service = emptyService();
  const existing = await service.createOrganization(input);
  const user = userEvent.setup();
  renderAt(`/organizations/${existing.id}/edit`, service);
  await openStep(user, 'Identity provider');
  const title = await screen.findByRole('textbox', { name: 'Title' });
  await user.clear(title);
  await user.paste('My unsaved title');
  // Another tab saves first, so the version this form read is stale.
  await service.updateOrganization(existing.id, input, existing.resourceVersion);
  await saveEdit(user);
  // The PoC's message, not the backend's text.
  expect(
    await screen.findByText('This organization was changed by another user. Reload the page, then try again.'),
  ).toBeVisible();
  expect(screen.getByText('Unable to save organization')).toBeVisible();
  expect(screen.getByRole('button', { name: 'Save changes' })).toBeEnabled();
  await openStep(user, 'Identity provider');
  expect(screen.getByRole('textbox', { name: 'Title' })).toHaveValue('My unsaved title');
  expect(service.organizations[0].identityProvider?.title).toBe('Tenant 1 SSO');
  expect(service.organizations[0].resourceVersion).toBe('2');
});

it('hides write actions until it knows the user is a provider admin', async () => {
  const service = unknownUser();
  const list = renderAt('/organizations', service);
  await waitFor(() => expect(screen.getByTestId('masthead-user')).toHaveTextContent('Unable to load user'));
  const table = await screen.findByTestId('organizations-table');
  expect(within(table).getByRole('link', { name: 'acme-robotics' })).toBeInTheDocument();
  expect(screen.queryByRole('link', { name: 'Create organization' })).not.toBeInTheDocument();
  expect(screen.queryByTestId('organization-actions-acme-robotics')).not.toBeInTheDocument();

  list.unmount();

  renderAt(`/organizations/${service.organizations[0].id}`, service);
  await waitFor(() => expect(screen.getByTestId('masthead-user')).toHaveTextContent('Unable to load user'));
  expect(await screen.findByRole('heading', { name: 'acme-robotics' })).toBeInTheDocument();
  expect(screen.queryByTestId('organization-actions')).not.toBeInTheDocument();
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
  await user.click(await screen.findByRole('textbox', { name: 'Name' }));
  await user.paste('tenant1');
  await user.click(screen.getByRole('button', { name: 'Next' }));
  await fillRequiredIdp(user, requiredIdp);
  await user.click(screen.getByRole('button', { name: 'Next' }));
  await user.click(screen.getByRole('button', { name: 'Create organization' }));
  expect(await screen.findByText('The organization is invalid.')).toBeVisible();
  // The wizard moves to the step with the field the server refused; Review shows no fields.
  const issuer = await screen.findByRole('textbox', { name: 'Issuer' });
  expect(issuer).toHaveAttribute('aria-invalid', 'true');
  expect(screen.getByText('Enter a valid HTTP or HTTPS URL.')).toBeVisible();
  // Editing the field clears the server's message for it.
  await user.click(issuer);
  await user.paste('/realms/x');
  expect(issuer).toHaveAttribute('aria-invalid', 'false');
  expect(screen.queryByText('Enter a valid HTTP or HTTPS URL.')).not.toBeInTheDocument();
});

it('deletes an organization from the list and says so', async () => {
  const service = emptyService();
  await service.createOrganization(input);
  const user = userEvent.setup();
  renderAt('/organizations', service);
  await user.click(await screen.findByRole('button', { name: 'Actions for tenant1' }));
  expect(screen.getByRole('menuitem', { name: 'View details' })).toBeVisible();
  await user.click(screen.getByRole('menuitem', { name: 'Delete' }));
  const modal = await screen.findByRole('dialog', { name: /Delete organization\?/ });
  await user.click(within(modal).getByRole('textbox'));
  await user.paste('tenant1');
  await user.click(within(modal).getByRole('button', { name: 'Delete' }));
  expect(await screen.findByText('Organization deleted')).toBeVisible();
  expect(await screen.findByRole('heading', { name: 'No organizations' })).toBeVisible();
});

it.each(['', '/edit'])('offers Retry when an organization fails to load: %s', async (suffix) => {
  const service = new MockConsoleService();
  const [first] = await service.listOrganizations();
  const get = service.getOrganization;
  service.getOrganization = async () => {
    service.getOrganization = get;
    throw new ServiceError(503, 'Service unavailable.');
  };
  const user = userEvent.setup();
  renderAt(`/organizations/${encodeURIComponent(first.id)}${suffix}`, service);
  expect(await screen.findByRole('heading', { name: 'Unable to load organization' })).toBeVisible();
  await user.click(screen.getByRole('button', { name: 'Retry' }));
  await waitFor(() => expect(screen.queryByTestId('error-state')).not.toBeInTheDocument());
  expect(screen.getByRole('heading', { level: 1, name: new RegExp(first.name) })).toBeVisible();
});

it('keeps the list under a warning when a reload fails', async () => {
  const service = new MockConsoleService();
  const user = userEvent.setup();
  renderAt('/organizations', service);
  expect(await screen.findByRole('link', { name: 'initech-labs' })).toBeVisible();
  vi.spyOn(service, 'listOrganizations').mockRejectedValue(new ServiceError(503, 'Service unavailable.'));
  await user.click(screen.getByRole('button', { name: 'Refresh' }));
  expect(await screen.findByTestId('stale-data-alert')).toHaveTextContent(
    'Showing the last loaded organizationsService unavailable.',
  );
  expect(screen.getByRole('link', { name: 'initech-labs' })).toBeVisible();
});

it('shows the not-available state when the backend cannot delete organizations yet', async () => {
  const service = new MockConsoleService();
  service.deleteOrganization = async () => {
    throw new ServiceError(501, 'The AI Grid backend does not support this operation.');
  };
  const user = userEvent.setup();
  renderAt('/organizations', service);
  await user.click(await screen.findByTestId('organization-actions-initech-labs'));
  await user.click(screen.getByRole('menuitem', { name: 'Delete' }));
  const modal = await screen.findByTestId('delete-organization-modal');
  await user.click(within(modal).getByTestId('delete-modal-input'));
  await user.paste('initech-labs');
  await user.click(within(modal).getByRole('button', { name: 'Delete' }));
  expect(
    await within(modal).findByText('Deleting organizations is not available on this AI Grid backend.'),
  ).toBeVisible();
  expect(within(modal).queryByText('The AI Grid backend does not support this operation.')).not.toBeInTheDocument();
});

it('shows one pagination, in the toolbar, for a single page', async () => {
  renderAt('/organizations', new MockConsoleService());
  expect(await screen.findByTestId('organizations-table')).toBeVisible();
  expect(screen.getAllByRole('navigation', { name: /pagination/i })).toHaveLength(1);
});

// The BFF's tenant JSON, as GET /api/v1/tenants/{id} sends it (mock/examples/get-tenant.json), trimmed.
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
  service.createOrganization = (value) => http.createOrganization(value);
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
  await user.paste('acme.example.net');
  await saveEdit(user);
  expect(await screen.findByText('Organization updated')).toBeVisible();

  const patch = fetchFn.mock.calls.find(([, init]) => init?.method === 'PATCH');
  expect(patch?.[0]).toBe(`/api/v1/tenants/${tenantJson.id}`);
  expect(patch?.[1]?.headers).toMatchObject({ 'If-Match': '"3"', 'Content-Type': 'application/json' });
  // The PoC can't rename, and alias, description, and attributes have no inputs: only these two go.
  expect(JSON.parse(String(patch?.[1]?.body))).toEqual({
    domains: ['acme.example.net'],
    identityProvider: { ...input.identityProvider, title: 'Acme SSO' },
  });
});

it('edit: clearing an existing identity provider is not a valid save', async () => {
  const fetchFn = vi.fn(async (url: string, _init?: RequestInit) =>
    jsonResponse(200, { data: url.endsWith('/tenants') ? [tenantJson] : tenantJson }),
  );
  const user = userEvent.setup();
  renderAt(`/organizations/${tenantJson.id}/edit`, serviceOnTenantJson(fetchFn as unknown as typeof fetch));
  await openStep(user, 'Identity provider');
  await waitFor(() => expect(screen.getByRole('textbox', { name: 'Client ID' })).toHaveValue('tenant1-client'));
  for (const box of screen.getAllByRole('textbox')) await user.clear(box);
  expect(screen.getByRole('button', { name: 'Review' })).toBeDisabled();
});

it('leaves the create form out of history once the organization is created, so Back skips it', async () => {
  let navigate: NavigateFunction = () => undefined;
  const CaptureNavigate = () => {
    navigate = useNavigate();
    return null;
  };
  const user = userEvent.setup();
  render(
    <MemoryRouter initialEntries={['/clusters', '/organizations/create']} initialIndex={1}>
      <CaptureNavigate />
      <TestApp service={new MockConsoleService()} />
    </MemoryRouter>,
  );
  await user.click(await screen.findByRole('textbox', { name: 'Name' }));
  await user.paste('frontfix-1');
  await user.click(screen.getByRole('button', { name: 'Next' }));
  await user.click(screen.getByRole('button', { name: 'Next' }));
  await user.click(screen.getByRole('button', { name: 'Create organization' }));
  expect(await screen.findByText('Organization created')).toBeVisible();
  await act(async () => navigate(-1));
  expect(await screen.findByRole('heading', { level: 1, name: 'Clusters' })).toBeVisible();
});

it('create without an identity provider sends none, and Review says so', async () => {
  const fetchFn = vi.fn(async (url: string, init?: RequestInit) =>
    init?.method === 'POST'
      ? jsonResponse(201, { data: { ...tenantJson, identityProvider: undefined } })
      : jsonResponse(200, { data: url.endsWith('/tenants') ? [] : tenantJson }),
  );
  const user = userEvent.setup();
  renderAt('/organizations/create', serviceOnTenantJson(fetchFn as unknown as typeof fetch));
  await user.click(await screen.findByRole('textbox', { name: 'Name' }));
  await user.paste('tenant1');
  await user.click(screen.getByRole('button', { name: 'Next' }));
  await user.click(screen.getByRole('button', { name: 'Next' }));
  expect(screen.getByTestId('organization-configuration-details')).toHaveTextContent(
    'No identity provider is configured.',
  );
  await user.click(screen.getByRole('button', { name: 'Create organization' }));
  expect(await screen.findByText('Organization created')).toBeVisible();
  const post = fetchFn.mock.calls.find(([, init]) => init?.method === 'POST');
  expect(JSON.parse(String(post?.[1]?.body))).toEqual({ name: 'tenant1', domains: [] });
});

it('lists the identity provider by title, a dash without one, and Disabled for a disabled organization', async () => {
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
  expect(within(acme).getByText('Enabled')).toBeInTheDocument();
  expect(acme).toHaveTextContent('Acme SSO');
  expect(acme).not.toHaveTextContent(tenantJson.identityProvider.config.issuer);
  const umbrella = screen.getByRole('row', { name: /^umbrella-biotech / });
  expect(within(umbrella).getByText('Disabled')).toBeInTheDocument();
  expect(within(umbrella).getAllByText('—')).toHaveLength(1);
});

it('the organization page shows its description, verified domains, attributes and created date, endpoints folded', async () => {
  const fetchFn = vi.fn(async () => jsonResponse(200, { data: tenantJson }));
  const user = userEvent.setup();
  renderAt(`/organizations/${tenantJson.id}`, serviceOnTenantJson(fetchFn as unknown as typeof fetch));
  const details = await screen.findByTestId('organization-configuration-details');
  expect(details).toHaveTextContent('Acme Robotics, EU region');
  expect(details).toHaveTextContent('acme-robotics.example.com Verified');
  expect(details).toHaveTextContent('billing-account: ACME-0042');
  // Created reads relative, as on every page, with the time itself on the element.
  expect(within(details).getByText(/ ago$/)).toHaveAttribute('datetime', '2026-09-01T09:00:00Z');
  const tokenUrl = screen.getByText(tenantJson.identityProvider.config.tokenUrl);
  expect(tokenUrl).not.toBeVisible();
  await user.click(screen.getByRole('button', { name: 'OIDC endpoints' }));
  expect(tokenUrl).toBeVisible();
});

it.each(['', '/edit'])('loads the other organization when the id in /organizations/:id%s changes', async (suffix) => {
  const service = new MockConsoleService();
  const [acme, globex] = service.organizations;
  let navigate: NavigateFunction = () => undefined;
  const Navigator = () => {
    navigate = useNavigate();
    return null;
  };
  render(
    <MemoryRouter initialEntries={[`/organizations/${acme.id}${suffix}`]}>
      <Navigator />
      <TestApp service={service} />
    </MemoryRouter>,
  );
  const shows = (name: string) =>
    waitFor(() =>
      suffix
        ? expect(screen.getByRole('textbox', { name: 'Name' })).toHaveValue(name)
        : expect(screen.getByRole('heading', { name })).toBeVisible(),
    );
  await shows(acme.name);
  await act(async () => navigate(`/organizations/${globex.id}${suffix}`));
  await shows(globex.name);
});

it('locks the edit wizard while it saves', async () => {
  const service = new MockConsoleService();
  const [organization] = service.organizations;
  let finish: () => void = () => undefined;
  const update = service.updateOrganization.bind(service);
  service.updateOrganization = (...args) =>
    new Promise((resolve, reject) => {
      finish = () => void update(...args).then(resolve, reject);
    });
  const user = userEvent.setup();
  renderAt(`/organizations/${encodeURIComponent(organization.id)}/edit`, service);
  await openStep(user, 'Identity provider');
  await user.click(await screen.findByRole('textbox', { name: 'Title' }));
  await user.paste(' (new)');
  await saveEdit(user);
  // The steps and the buttons stay put until the save answers.
  expect(screen.getByRole('button', { name: 'Identity provider' })).toBeDisabled();
  expect(screen.getByRole('button', { name: 'Back' })).toBeDisabled();
  expect(screen.getByRole('button', { name: 'Cancel' })).toBeDisabled();
  finish();
  expect(await screen.findByText('Organization updated')).toBeVisible();
});

it('moves an edit refused for a field to that field, once, and lets the user return to Review', async () => {
  const service = new MockConsoleService();
  const [organization] = service.organizations;
  service.updateOrganization = async () => {
    throw new ServiceError(422, 'The organization is invalid.', {
      'identityProvider.config.issuer': 'Enter a valid HTTP or HTTPS URL.',
    });
  };
  const user = userEvent.setup();
  renderAt(`/organizations/${encodeURIComponent(organization.id)}/edit`, service);
  await openStep(user, 'Identity provider');
  await user.click(await screen.findByRole('textbox', { name: 'Title' }));
  await user.paste(' (new)');
  await saveEdit(user);
  // On the Identity provider step, with the server's message next to Issuer.
  expect(await screen.findByRole('textbox', { name: 'Issuer' })).toHaveAttribute('aria-invalid', 'true');
  expect(screen.getByText('Enter a valid HTTP or HTTPS URL.')).toBeVisible();
  // Going back to Review stays there: the move happens once per refused save.
  await openStep(user, 'Review');
  expect(screen.getByRole('button', { name: 'Save changes' })).toBeVisible();
  expect(screen.queryByRole('textbox', { name: 'Issuer' })).not.toBeInTheDocument();
});

it('reloads an organization after a stale delete from its page, keeping the typed name, so a retry succeeds', async () => {
  const service = new MockConsoleService();
  const [organization] = service.organizations;
  const user = userEvent.setup();
  renderAt(`/organizations/${organization.id}`, service);
  await user.click(await screen.findByTestId('organization-actions'));
  await user.click(screen.getByRole('menuitem', { name: 'Delete' }));
  const modal = await screen.findByTestId('delete-organization-modal');
  await user.click(within(modal).getByTestId('delete-modal-input'));
  await user.paste(organization.name);
  // Someone else saves the organization while the dialog is open.
  service.organizations[0] = { ...organization, resourceVersion: String(Number(organization.resourceVersion) + 1) };
  await user.click(within(modal).getByRole('button', { name: 'Delete' }));
  expect(
    await within(modal).findByText(
      'This organization was changed after this dialog opened. The latest version is now shown. Review it and try again.',
    ),
  ).toBeVisible();
  expect(within(modal).getByTestId('delete-modal-input')).toHaveValue(organization.name);
  await user.click(within(modal).getByRole('button', { name: 'Delete' }));
  expect(await screen.findByText('Organization deleted')).toBeVisible();
  expect(service.organizations.some((o) => o.id === organization.id)).toBe(false);
});

it('keeps the delete dialog busy until the reloaded organization is in, and says when the reload fails', async () => {
  const service = new MockConsoleService();
  const [organization] = service.organizations;
  const user = userEvent.setup();
  renderAt('/organizations', service);
  await user.click(await screen.findByRole('button', { name: `Actions for ${organization.name}` }));
  await user.click(screen.getByRole('menuitem', { name: 'Delete' }));
  const modal = await screen.findByTestId('delete-organization-modal');
  await user.click(within(modal).getByTestId('delete-modal-input'));
  await user.paste(organization.name);
  service.organizations[0] = { ...organization, resourceVersion: String(Number(organization.resourceVersion) + 1) };
  const deleteSpy = vi.spyOn(service, 'deleteOrganization');
  const reload = deferred<Organization>();
  const reloadSpy = vi.spyOn(service, 'getOrganization').mockReturnValueOnce(reload.promise);
  await user.click(within(modal).getByRole('button', { name: 'Delete' }));
  await waitFor(() => expect(reloadSpy).toHaveBeenCalledTimes(1));
  // The reload is still out: Delete stays busy, so no retry with the stale version.
  expect(within(modal).getByRole('button', { name: /Delete/ })).toBeDisabled();
  await user.type(within(modal).getByTestId('delete-modal-input'), '{Enter}');
  expect(deleteSpy).toHaveBeenCalledTimes(1);
  await act(async () => {
    reload.resolve(service.organizations[0]);
  });
  expect(within(modal).getByRole('button', { name: 'Delete' })).toBeEnabled();

  // A second stale delete whose reload fails says so.
  service.organizations[0] = {
    ...service.organizations[0],
    resourceVersion: String(Number(service.organizations[0].resourceVersion) + 1),
  };
  reloadSpy.mockRejectedValueOnce(new ServiceError(503, 'Service unavailable.'));
  await user.click(within(modal).getByRole('button', { name: 'Delete' }));
  expect(await within(modal).findByText(/Unable to reload the latest version: Service unavailable\./)).toBeVisible();
  expect(within(modal).getByRole('button', { name: 'Delete' })).toBeEnabled();
});

it('moves focus to the previous domain on Remove domain, or to Add domain when none is left', async () => {
  const user = userEvent.setup();
  renderAt('/organizations/create', new MockConsoleService());
  const add = await screen.findByRole('button', { name: 'Add domain' });
  await user.click(add);
  await user.click(screen.getByRole('textbox', { name: /^Domain 1/ }));
  await user.paste('one.example.com');
  await user.click(add);
  await user.click(screen.getByRole('textbox', { name: /^Domain 2/ }));
  await user.paste('two.example.com');
  await user.click(add);
  await user.click(screen.getByRole('button', { name: 'Remove domain 3' }));
  expect(screen.getByRole('textbox', { name: /^Domain 2/ })).toHaveFocus();
  // The first has no previous one: focus goes to the domain that takes its place.
  await user.click(screen.getByRole('button', { name: 'Remove domain 1' }));
  expect(screen.getByRole('textbox', { name: /^Domain 1/ })).toHaveFocus();
  expect(screen.getByRole('textbox', { name: /^Domain 1/ })).toHaveValue('two.example.com');
  await user.click(screen.getByRole('button', { name: 'Remove domain 1' }));
  expect(screen.queryByRole('textbox', { name: /^Domain/ })).not.toBeInTheDocument();
  expect(screen.getByRole('button', { name: 'Add domain' })).toHaveFocus();
});

it('heads the wizard sections at h2, moves focus to an added domain, and names the delete field by its prompt', async () => {
  const service = new MockConsoleService();
  const user = userEvent.setup();
  const wizard = renderAt('/organizations/create', service);
  expect(await screen.findByRole('heading', { level: 2, name: 'Domains' })).toBeVisible();
  await user.click(screen.getByRole('button', { name: 'Add domain' }));
  const domains = screen.getAllByRole('textbox', { name: /^Domain \d/ });
  expect(domains[domains.length - 1]).toHaveFocus();
  wizard.unmount();

  const [organization] = service.organizations;
  renderAt(`/organizations/${organization.id}`, service);
  await user.click(await screen.findByTestId('organization-actions'));
  await user.click(screen.getByRole('menuitem', { name: 'Delete' }));
  const modal = await screen.findByTestId('delete-organization-modal');
  expect(within(modal).getByRole('textbox', { name: `Type ${organization.name} to confirm:` })).toBeVisible();
});
