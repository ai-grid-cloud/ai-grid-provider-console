// Ported from krisv/ai-grid-cloud-provider-poc src/app/__tests__/tenants.test.tsx at 62319b8.
// The PoC drives its Git-backed API; here the same cases run on the backend's Tenants API over
// Connect, answered by connectTenants.ts's FakeTenants, which follows the backend's rules and
// messages at .backend-api-version.
// Rulings: the localStorage persistence case keeps only its stale-version assertions (D3), and
// the "name matches the create route" case opens an organization named create by id (D2).
import { create } from '@bufbuild/protobuf';
import { act, render, screen, waitFor, within } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { Code, ConnectError } from '@connectrpc/connect';
import { MemoryRouter, useNavigate } from 'react-router-dom';
import type { NavigateFunction } from 'react-router-dom';
import { ServiceError } from '../api/ConsoleService';
import { fakeClients } from '../api/connect/testing';
import { MockConsoleService } from '../api/MockConsoleService';
import { TenantSchema, type Tenant } from '../gen/ai_grid/v1/tenant_type_pb';
import { tenantOf, toOrganizationView, type OrganizationInput } from '../pages/organizations/organizationView';
import { ACME_ID, GLOBEX_ID, fieldViolations, tenantsOf } from './connectTenants';
import { deferred, renderAt, findVisible } from './render';
// The routes load these pages lazily; loaded here, their import does not run inside a test's findBy.
import '../pages/organizations/OrganizationDetailsPage';
import '../pages/organizations/OrganizationListPage';
import '../pages/organizations/OrganizationWizardPage';
import { notificationsKey } from '../notifications/storageKeys';
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
      jwksUrl: 'https://sso.example.com/certs',
      logoutUrl: '',
      validateSignature: true,
    },
  },
};

/** A console whose backend has no organizations. */
const emptyService = () => {
  const service = new MockConsoleService();
  tenantsOf(service).tenants = [];
  return service;
};

/** Stores an organization in the service's backend, as a Create would, at version 1. */
const addOrganization = (service: object, value: OrganizationInput, id = `org-${value.name}`) => {
  const { metadata, spec } = tenantOf(value);
  const tenant = create(TenantSchema, { id, metadata, spec, status: {} });
  if (tenant.metadata) tenant.metadata.version = 1;
  tenantsOf(service).tenants.push(tenant);
  return toOrganizationView(tenant);
};

/** The organizations the service's backend stores, by id. */
const storedIds = (service: object) => tenantsOf(service).tenants.map((t) => t.id);

/** A copy of what the backend stores now, to compare with later. */
const snapshot = (service: object): Tenant[] => tenantsOf(service).tenants.map((t) => create(TenantSchema, t));

const unavailable = () => new ConnectError('keycloak is unreachable', Code.Unavailable);
/** The console's words for Unavailable (describeError): the backend's own message isn't shown. */
const UNAVAILABLE = 'The AI grid backend is unavailable. Try again.';

const NO_IDP = 'No identity provider configured in AI grid';
const NO_IDP_REASON =
  "Unless an identity provider was set up directly in Keycloak, this organization's users cannot log in.";

const MAYBE_SAVED =
  'The AI grid backend could not confirm the save, so the changes may have been saved. Reload the page to check, then try again if they are missing.';
const ISSUER_MAYBE_SAVED =
  'If the new issuer was saved, users already log in through it, so test logging in only after the reloaded page shows the new issuer.';

type User = ReturnType<typeof userEvent.setup>;

/** Opens an edit wizard step from its navigation: every step is open from the start when editing. */
const openStep = async (user: User, name: 'Organization details' | 'Identity provider' | 'Review') =>
  user.click(await screen.findByRole('button', { name }));

/** Opens Review and saves the edit. */
const saveEdit = async (user: User) => {
  await openStep(user, 'Review');
  await user.click(screen.getByRole('button', { name: 'Save' }));
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
  // Required while Validate signature is on, as it is by default.
  ['JSON Web Key Set (JWKS) URL', 'https://idp.example.com/certs'],
];

it('onboards organization details then IdP, saves only after review and orders navigation', async () => {
  const service = emptyService();
  const user = userEvent.setup();
  renderAt('/organizations', service);
  expect(await screen.findByRole('heading', { name: 'Organizations' })).toBeVisible();
  expect(
    screen.getByText(
      'Manage organizations that can access models in the AI grid. An organization contains users who all sign in through the same identity provider.',
    ),
  ).toBeVisible();
  const nav = screen.getByRole('navigation', { name: 'Console sections' });
  expect(
    within(nav)
      .getAllByRole('link')
      .map((link) => link.textContent),
  ).toEqual(['AI grid', 'Monitoring', 'Clusters', 'Organizations', 'Models', 'Subscriptions']);
  await user.click(await screen.findByRole('link', { name: 'Create organization' }));
  const name = await screen.findByRole('textbox', { name: 'Name' });
  expect(screen.getByText('Valid characters include lowercase letters, numbers, and hyphens (-).')).toBeVisible();
  expect(screen.getByRole('button', { name: 'Next' })).toBeDisabled();
  await user.click(name);
  await user.paste('tenant1');
  await user.click(screen.getByRole('button', { name: 'Add domain' }));
  await user.click(screen.getByRole('textbox', { name: 'Domain 1' }));
  await user.paste('tenant1.example.com');
  await user.click(screen.getByRole('button', { name: 'Add domain' }));
  await user.click(screen.getByRole('button', { name: 'Remove domain 2' }));
  await user.click(screen.getByRole('button', { name: 'Next' }));
  // A new identity provider's issuer has an example, not what changing a saved one does.
  expect(screen.queryByText(/The issuer can be edited only until/)).not.toBeInTheDocument();
  // A blank identity provider is optional; a partly filled one isn't.
  expect(screen.getByRole('button', { name: 'Next' })).toBeEnabled();
  await user.click(screen.getByRole('textbox', { name: 'Identity provider name' }));
  await user.paste('Tenant 1 SSO');
  expect(screen.getByRole('button', { name: 'Next' })).toBeDisabled();
  expect(tenantsOf(service).sent('create')).toEqual([]);
  await fillRequiredIdp(user, [
    ['Client ID', 'tenant1-client'],
    ['Client secret reference', 'tenant1-secret'],
    ['Issuer', 'https://sso.example.com/tenant1'],
    ['Authorization URL', 'https://sso.example.com/auth'],
    ['Token URL', 'https://sso.example.com/token'],
    ['JSON Web Key Set (JWKS) URL', 'https://sso.example.com/certs'],
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
  expect(screen.getByRole('textbox', { name: 'Identity provider name' })).toHaveValue('Tenant 1 SSO');
  await user.click(screen.getByRole('button', { name: 'Next' }));
  await user.click(screen.getByRole('button', { name: 'Create organization' }));
  const table = await screen.findByTestId('organizations-table');
  expect(table).toHaveTextContent('Tenant 1 SSO');
  expect(table).toHaveTextContent('tenant1.example.com');
  expect(await screen.findByText('Organization tenant1 created')).toBeVisible();
  const [sent] = tenantsOf(service).sent('create');
  expect(sent.object?.metadata?.name).toBe('tenant1');
  expect(sent.object?.spec?.domains).toEqual(['tenant1.example.com']);
  expect(tenantsOf(service).tenants[0].spec?.identityProvider?.config?.clientSecretSecretName).toBe('tenant1-secret');
});

it('opens an organization from the list and edits its domains, with until when the issuer can change', async () => {
  const service = emptyService();
  addOrganization(service, input);
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
  expect(await screen.findByRole('heading', { name: 'Edit organization' })).toBeVisible();
  expect(screen.getByText('tenant1', { selector: 'strong' })).toBeVisible();
  expect(screen.getByRole('textbox', { name: 'Name' })).toHaveAttribute('readonly');
  expect(screen.getByText('The name cannot be edited after the organization is created.')).toBeVisible();
  // Nothing changed yet, so Review can't save.
  await openStep(user, 'Review');
  expect(screen.getByRole('button', { name: 'Save' })).toBeDisabled();
  // Every identity provider field can change, the issuer too, whose help says until when.
  await openStep(user, 'Identity provider');
  expect(screen.getByRole('textbox', { name: 'Identity provider name' })).toBeEnabled();
  expect(screen.getByRole('textbox', { name: 'Client ID' })).toBeEnabled();
  expect(screen.getByRole('textbox', { name: 'Issuer' })).toBeEnabled();
  expect(screen.getByRole('textbox', { name: 'Issuer' })).not.toHaveAttribute('readonly');
  expect(
    screen.getByText(
      "The issuer can be edited only until a user logs in through this identity provider. After that, to use a different issuer, remove the users' links to this identity provider in Keycloak, or create a new organization.",
    ),
  ).toBeVisible();
  await openStep(user, 'Organization details');
  const domain = screen.getByRole('textbox', { name: 'Domain 1' });
  await user.clear(domain);
  await user.paste('updated.example.com');
  await saveEdit(user);
  expect(await screen.findByText('Changes to organization tenant1 saved')).toBeVisible();
  const details = await screen.findByTestId('organization-configuration-details');
  expect(details).toHaveTextContent('updated.example.com');
  expect(details).toHaveTextContent('https://sso.example.com/tenant1');
});

it('deletes an organization from its page after its name is typed', async () => {
  const service = emptyService();
  addOrganization(service, input);
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
  expect(await screen.findByText('Organization tenant1 deleted')).toBeVisible();
  // The list reloads after the delete; the toast can show before it does.
  expect(await screen.findByRole('heading', { name: 'No organizations' })).toBeVisible();
  expect(tenantsOf(service).tenants).toEqual([]);
});

it('keeps a refused create on the form, without a notification of its own', async () => {
  const service = emptyService();
  addOrganization(service, input);
  const user = userEvent.setup();
  renderAt('/organizations/create', service);
  await user.click(await screen.findByRole('textbox', { name: 'Name' }));
  await user.paste('tenant1');
  await user.click(screen.getByRole('button', { name: 'Next' }));
  await user.click(screen.getByRole('button', { name: 'Next' }));
  await user.click(screen.getByRole('button', { name: 'Create organization' }));
  // The backend's AlreadyExists, in its words.
  expect(await screen.findByText('tenant "tenant1" already exists')).toBeVisible();
  // The form says it once; the notification center says nothing.
  expect(screen.getAllByText('tenant "tenant1" already exists')).toHaveLength(1);
  expect(window.sessionStorage.getItem(notificationsKey('dev-user'))).toBeNull();
});

it('keeps each organization write in the drawer, named, with a link to the organization', async () => {
  const service = emptyService();
  const created = addOrganization(service, input);
  const user = userEvent.setup();
  renderAt(`/organizations/${created.id}/edit`, service);
  await user.click(await screen.findByRole('textbox', { name: 'Domain 1' }));
  await user.paste('x');
  await saveEdit(user);
  expect(await screen.findByText('Changes to organization tenant1 saved')).toBeVisible();
  const stored = JSON.parse(window.sessionStorage.getItem(notificationsKey('dev-user')) ?? '[]') as {
    title: string;
    read: boolean;
    actions?: { title: string; to: string }[];
  }[];
  // In answer to the user's own click: kept as read.
  expect(stored).toMatchObject([
    {
      title: 'Changes to organization tenant1 saved',
      read: true,
      actions: [{ title: 'View organization', to: `/organizations/${created.id}` }],
    },
  ]);
});

it('keeps onboarding input on conflicts and allows cancel without saving', async () => {
  const service = emptyService();
  addOrganization(service, input);
  const user = userEvent.setup();
  renderAt('/organizations/create', service);
  await user.click(await screen.findByRole('textbox', { name: 'Name' }));
  await user.paste('tenant1');
  await user.click(screen.getByRole('button', { name: 'Next' }));
  await fillRequiredIdp(user, requiredIdp);
  await user.click(screen.getByRole('button', { name: 'Next' }));
  await user.click(screen.getByRole('button', { name: 'Create organization' }));
  // The backend's AlreadyExists, in its words.
  expect(await screen.findByText('tenant "tenant1" already exists')).toBeVisible();
  expect(screen.getByTestId('organization-configuration-details')).toHaveTextContent('tenant1');
  await user.click(screen.getByRole('button', { name: 'Cancel' }));
  await user.click(within(await screen.findByTestId('discard-changes-modal')).getByRole('button', { name: 'Discard' }));
  expect(await screen.findByTestId('organizations-table')).toHaveTextContent('Tenant 1 SSO');
  expect(tenantsOf(service).tenants).toHaveLength(1);
});

// The version rules every page test relies on, as the backend's Tenants answers them.
it('protects edits from stale versions', async () => {
  const service = emptyService();
  const { clients } = fakeClients({ tenants: tenantsOf(service).backend() });
  const organization = addOrganization(service, input);
  const read = (await clients.tenants.get({ id: organization.id })).object;
  expect(read && toOrganizationView(read)).toEqual(organization);
  const next = await clients.tenants.update({
    object: { id: organization.id, metadata: { version: organization.version }, spec: { domains: [] } },
    updateMask: { paths: ['spec.domains'] },
    lock: true,
  });
  expect(next.object?.metadata?.version).toBe(2);
  await expect(
    clients.tenants.update({
      object: { id: organization.id, metadata: { version: organization.version }, spec: { domains: input.domains } },
      updateMask: { paths: ['spec.domains'] },
      lock: true,
    }),
  ).rejects.toMatchObject({
    code: Code.Aborted,
    rawMessage: `update tenant "${organization.id}": the tenant changed since it was read; reload and retry`,
  });
  await expect(clients.tenants.delete({ id: organization.id, version: organization.version })).rejects.toMatchObject({
    code: Code.Aborted,
    rawMessage: `delete tenant "${organization.id}": the tenant changed since it was read; reload and retry`,
  });
  await clients.tenants.delete({ id: organization.id, version: 2 });
  expect(tenantsOf(service).tenants).toEqual([]);
});

it('shows a retry action when organization loading fails', async () => {
  const service = emptyService();
  tenantsOf(service).before.list = () => {
    delete tenantsOf(service).before.list;
    throw unavailable();
  };
  const user = userEvent.setup();
  renderAt('/organizations', service);
  expect(await screen.findByText(UNAVAILABLE)).toBeVisible();
  await user.click(screen.getByRole('button', { name: 'Retry' }));
  expect(await screen.findByRole('heading', { name: 'No organizations' })).toBeVisible();
});

it('an organization named create opens its details by id', async () => {
  const service = emptyService();
  const created = addOrganization(service, { ...input, name: 'create', domains: [] });
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
  addOrganization(service, input);
  const existing = snapshot(service);
  const user = userEvent.setup();
  renderAt('/organizations/create', service);
  await user.click(await screen.findByRole('textbox', { name: 'Name' }));
  await user.paste('unsaved-tenant');
  expect(screen.getByRole('button', { name: 'Back' })).toBeDisabled();
  await user.click(screen.getByRole('button', { name: 'Next' }));
  await user.click(screen.getByRole('textbox', { name: 'Identity provider name' }));
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
  expect(tenantsOf(service).tenants).toEqual(existing);
});

it('edit: Cancel leaves at once without changes, and returns to the organization after discarding', async () => {
  const service = emptyService();
  const existing = addOrganization(service, input);
  const stored = snapshot(service);
  const user = userEvent.setup();
  renderAt(`/organizations/${existing.id}/edit`, service);
  await user.click(await screen.findByRole('button', { name: 'Cancel' }));
  expect(await screen.findByTestId('organization-configuration-details')).toBeVisible();
  expect(screen.queryByTestId('discard-changes-modal')).not.toBeInTheDocument();

  await user.click(screen.getByTestId('organization-actions'));
  await user.click(screen.getByRole('menuitem', { name: 'Edit' }));
  const domain = await screen.findByRole('textbox', { name: 'Domain 1' });
  await user.clear(domain);
  await user.paste('unsaved.example.com');
  await user.click(screen.getByRole('button', { name: 'Cancel' }));
  await user.click(within(await screen.findByTestId('discard-changes-modal')).getByRole('button', { name: 'Discard' }));
  expect(await screen.findByTestId('organization-configuration-details')).toHaveTextContent('Tenant 1 SSO');
  expect(tenantsOf(service).tenants).toEqual(stored);
});

it('keeps input on conflict', async () => {
  const service = emptyService();
  const existing = addOrganization(service, input);
  const user = userEvent.setup();
  renderAt(`/organizations/${existing.id}/edit`, service);
  const domain = await screen.findByRole('textbox', { name: 'Domain 1' });
  await user.clear(domain);
  await user.paste('unsaved.example.com');
  // Another tab saves first, so the version this form read is stale.
  tenantsOf(service).bump(existing.id);
  await saveEdit(user);
  // The PoC's message, not the backend's text.
  expect(
    await screen.findByText('This organization was changed by another user. Reload the page, then try again.'),
  ).toBeVisible();
  expect(screen.getByText('Unable to save organization')).toBeVisible();
  expect(screen.getByRole('button', { name: 'Save' })).toBeEnabled();
  await openStep(user, 'Organization details');
  expect(screen.getByRole('textbox', { name: 'Domain 1' })).toHaveValue('unsaved.example.com');
  expect(tenantsOf(service).tenants[0].spec?.domains).toEqual(['tenant1.example.com']);
  expect(tenantsOf(service).tenants[0].metadata?.version).toBe(2);
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

  renderAt(`/organizations/${ACME_ID}`, service);
  await waitFor(() => expect(screen.getByTestId('masthead-user')).toHaveTextContent('Unable to load user'));
  expect(await screen.findByRole('heading', { name: 'acme-robotics' })).toBeInTheDocument();
  expect(screen.queryByTestId('organization-actions')).not.toBeInTheDocument();
});

it('shows field errors from the server next to the field', async () => {
  const service = emptyService();
  // The backend names the field by its proto path; the form shows it next to Issuer.
  tenantsOf(service).before.create = () => {
    throw fieldViolations('The organization is invalid.', {
      'spec.identity_provider.config.issuer': 'Enter a valid HTTP or HTTPS URL.',
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
  addOrganization(service, input);
  const user = userEvent.setup();
  renderAt('/organizations', service);
  await user.click(await screen.findByRole('button', { name: 'Actions for tenant1' }));
  await findVisible('menuitem', 'View details');
  await user.click(screen.getByRole('menuitem', { name: 'Delete' }));
  const modal = await screen.findByRole('dialog', { name: /Delete organization\?/ });
  await user.click(within(modal).getByRole('textbox'));
  await user.paste('tenant1');
  await user.click(within(modal).getByRole('button', { name: 'Delete' }));
  expect(await screen.findByText('Organization tenant1 deleted')).toBeVisible();
  expect(await screen.findByRole('heading', { name: 'No organizations' })).toBeVisible();
});

it.each(['', '/edit'])('offers Retry when an organization fails to load: %s', async (suffix) => {
  const service = new MockConsoleService();
  const first = { id: ACME_ID, name: 'acme-robotics' };
  tenantsOf(service).before.get = () => {
    delete tenantsOf(service).before.get;
    throw unavailable();
  };
  const user = userEvent.setup();
  renderAt(`/organizations/${encodeURIComponent(first.id)}${suffix}`, service);
  expect(await screen.findByRole('heading', { name: 'Unable to load organization' })).toBeVisible();
  await user.click(screen.getByRole('button', { name: 'Retry' }));
  await waitFor(() => expect(screen.queryByTestId('error-state')).not.toBeInTheDocument());
  if (suffix) {
    // Edit names the organization in its description, under the page title.
    expect(screen.getByRole('heading', { level: 1, name: 'Edit organization' })).toBeVisible();
    expect(screen.getByText(first.name, { selector: 'strong' })).toBeVisible();
  } else {
    expect(screen.getByRole('heading', { level: 1, name: new RegExp(first.name) })).toBeVisible();
  }
});

it('keeps the list under a warning when a reload fails', async () => {
  const service = new MockConsoleService();
  const user = userEvent.setup();
  renderAt('/organizations', service);
  expect(await screen.findByRole('link', { name: 'initech-labs' })).toBeVisible();
  tenantsOf(service).before.list = () => {
    throw unavailable();
  };
  await user.click(screen.getByRole('button', { name: 'Refresh' }));
  expect(await screen.findByTestId('stale-data-alert')).toHaveTextContent(
    `Showing the last loaded organizations${UNAVAILABLE}`,
  );
  expect(screen.getByRole('link', { name: 'initech-labs' })).toBeVisible();
});

it('shows the not-available state when the backend cannot delete organizations yet', async () => {
  const service = new MockConsoleService();
  tenantsOf(service).before.delete = () => {
    throw new ConnectError('no such method', Code.Unimplemented);
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
    await within(modal).findByText('Deleting organizations is not available on this AI grid backend.'),
  ).toBeVisible();
  expect(within(modal).queryByText('The AI grid backend does not support this operation.')).not.toBeInTheDocument();
});

it('shows one pagination, in the toolbar, for a single page', async () => {
  renderAt('/organizations', new MockConsoleService());
  expect(await screen.findByTestId('organizations-table')).toBeVisible();
  expect(screen.getAllByRole('navigation', { name: /pagination/i })).toHaveLength(1);
});

it('edit sends Tenants/Update with the domains, their mask and the version read, leaving an unchanged identity provider out', async () => {
  const service = new MockConsoleService();
  // acme-robotics after two edits elsewhere.
  tenantsOf(service).bump(ACME_ID);
  tenantsOf(service).bump(ACME_ID);
  const user = userEvent.setup();
  renderAt(`/organizations/${ACME_ID}/edit`, service);
  const domain = await screen.findByRole('textbox', { name: 'Domain 1' });
  await waitFor(() => expect(domain).toHaveValue('acme-robotics.example.com'));
  await user.clear(domain);
  await user.paste('acme.example.net');
  await saveEdit(user);
  expect(await screen.findByText('Changes to organization acme-robotics saved')).toBeVisible();

  const [update] = tenantsOf(service).sent('update');
  expect(update.object?.id).toBe(ACME_ID);
  expect(update.object?.metadata?.version).toBe(3);
  expect(update.lock).toBe(true);
  // The name can't change, and the identity provider didn't: only the domains go, and the mask
  // names them alone.
  expect(update.updateMask?.paths).toEqual(['spec.domains']);
  expect(update.object?.spec?.domains).toEqual(['acme.example.net', 'acme.example.org']);
  expect(update.object?.spec?.identityProvider).toBeUndefined();
  expect(update.object?.metadata?.name).toBe('');
});

it('edit: changes an identity provider in place, its issuer included, with its mask', async () => {
  const service = new MockConsoleService();
  const user = userEvent.setup();
  renderAt(`/organizations/${ACME_ID}/edit`, service);
  await openStep(user, 'Identity provider');
  const clientId = screen.getByRole('textbox', { name: 'Client ID' });
  await waitFor(() => expect(clientId).toHaveValue('ai-grid'));
  await user.clear(clientId);
  await user.paste('ai-grid-v2');
  const secret = screen.getByRole('textbox', { name: 'Client secret reference' });
  await user.clear(secret);
  await user.paste('acme-robotics-oidc-client-v2');
  await user.click(screen.getByRole('checkbox', { name: 'Validate signature' }));
  const issuer = screen.getByRole('textbox', { name: 'Issuer' });
  await user.clear(issuer);
  await user.paste('https://sso.example.com/realms/acme-corp');
  // The backend refuses a new issuer once a user has logged in through the provider, so the form
  // warns under the field while it holds one.
  expect(
    screen.getByText('A new issuer is saved only if no user has logged in through this identity provider'),
  ).toBeVisible();
  await saveEdit(user);
  expect(await screen.findByText('Changes to organization acme-robotics saved')).toBeVisible();

  const [update] = tenantsOf(service).sent('update');
  // The domains didn't change, so only the identity provider goes, and the mask names it alone.
  expect(update.updateMask?.paths).toEqual(['spec.identity_provider']);
  expect(update.object?.metadata?.version).toBe(1);
  const config = update.object?.spec?.identityProvider?.config;
  expect(config?.clientId).toBe('ai-grid-v2');
  expect(config?.clientSecretSecretName).toBe('acme-robotics-oidc-client-v2');
  expect(config?.validateSignature).toBe(false);
  expect(config?.issuer).toBe('https://sso.example.com/realms/acme-corp');
  expect(update.object?.spec?.domains).toEqual([]);
  const stored = tenantsOf(service).find(ACME_ID);
  expect(stored?.spec?.domains).toEqual(['acme-robotics.example.com', 'acme.example.org']);
  expect(stored?.metadata?.version).toBe(2);
  expect(stored?.spec?.identityProvider?.config?.clientId).toBe('ai-grid-v2');
  expect(stored?.spec?.identityProvider?.config?.issuer).toBe('https://sso.example.com/realms/acme-corp');
  const details = await screen.findByTestId('organization-configuration-details');
  expect(details).toHaveTextContent('ai-grid-v2');
  expect(details).toHaveTextContent('https://sso.example.com/realms/acme-corp');
});

it('edit: an identity provider is validated as on create and cannot be removed', async () => {
  const service = new MockConsoleService();
  const user = userEvent.setup();
  renderAt(`/organizations/${ACME_ID}/edit`, service);
  await openStep(user, 'Identity provider');
  const clientId = screen.getByRole('textbox', { name: 'Client ID' });
  await waitFor(() => expect(clientId).toHaveValue('ai-grid'));
  await user.clear(clientId);
  await user.tab();
  expect(screen.getByText('Client ID is required.')).toBeVisible();
  expect(screen.getByRole('button', { name: 'Review' })).toBeDisabled();
  // Clearing every field doesn't remove it: a blank provider is as invalid as a partial one.
  for (const name of [
    'Identity provider name',
    'Description',
    'Client secret reference',
    'Default scopes',
    'Authorization URL',
    'Token URL',
    'User info URL',
    'JSON Web Key Set (JWKS) URL',
    'Logout URL',
  ]) {
    await user.clear(screen.getByRole('textbox', { name }));
  }
  expect(screen.getByRole('button', { name: 'Review' })).toBeDisabled();
  expect(screen.queryByRole('button', { name: /remove/i })).not.toBeInTheDocument();
  expect(tenantsOf(service).sent('update')).toEqual([]);
});

it("edit: shows an identity provider refused in the backend's words, and a save it could not confirm as possibly saved", async () => {
  const service = new MockConsoleService();
  const refusal = new ConnectError(
    'spec.identity_provider.config.issuer "https://sso.example.com/realms/acme-robotics" does not match the issuer "https://other.example.com" that its discovery document https://sso.example.com/realms/acme-robotics/.well-known/openid-configuration names',
    Code.InvalidArgument,
  );
  const answers = [refusal, unavailable()];
  tenantsOf(service).before.update = () => {
    throw answers.shift();
  };
  const user = userEvent.setup();
  renderAt(`/organizations/${ACME_ID}/edit`, service);
  await openStep(user, 'Identity provider');
  const title = screen.getByRole('textbox', { name: 'Identity provider name' });
  await waitFor(() => expect(title).toHaveValue('Acme Robotics SSO'));
  await user.click(title);
  await user.paste(' v2');
  await saveEdit(user);
  expect(await screen.findByText('Unable to save organization')).toBeVisible();
  expect(screen.getByText(refusal.rawMessage)).toBeVisible();

  await user.click(screen.getByRole('button', { name: 'Save' }));
  // The issuer didn't change, so the message says nothing about it.
  expect(await screen.findByText(MAYBE_SAVED)).toBeVisible();
  expect(screen.queryByText(UNAVAILABLE)).not.toBeInTheDocument();
  // The form keeps the input.
  await openStep(user, 'Identity provider');
  expect(screen.getByRole('textbox', { name: 'Identity provider name' })).toHaveValue('Acme Robotics SSO v2');
});

it.each([
  [
    // A save the relay stopped waiting for may have landed, as one answered Unavailable.
    'DeadlineExceeded as possibly saved',
    new ConnectError('the backend did not answer in time', Code.DeadlineExceeded),
    MAYBE_SAVED,
  ],
  [
    // The stored provider's Secret, which the backend reads to restore it if the change fails.
    "a missing Secret of the stored provider in the backend's words",
    new ConnectError(
      'read Secret "acme-robotics-oidc-client", the current identity provider\'s client secret, which restores it if this change fails: not found; recreate that Secret with the client secret Keycloak has now, then retry',
      Code.FailedPrecondition,
    ),
    'read Secret "acme-robotics-oidc-client", the current identity provider\'s client secret, which restores it if this change fails: not found; recreate that Secret with the client secret Keycloak has now, then retry',
  ],
  [
    // The Secret the change names.
    "a missing Secret of the requested provider in the backend's words",
    new ConnectError('identity provider secret "acme-robotics-oidc-client" not found', Code.NotFound),
    'identity provider secret "acme-robotics-oidc-client" not found',
  ],
  [
    // A new issuer once a user has logged in through the provider.
    "a new issuer after users logged in in the backend's words",
    new ConnectError(
      'spec.identity_provider.config.issuer can\'t change after members have signed in through identity provider "acme-robotics" (3 linked): Keycloak links a member by the provider alias and the subject the provider sends, so a user of the new issuer with a matching subject would sign in as that member. To correct it, create a new organization, or remove the members\' links to the identity provider in Keycloak first',
      Code.FailedPrecondition,
    ),
    'spec.identity_provider.config.issuer can\'t change after members have signed in through identity provider "acme-robotics" (3 linked): Keycloak links a member by the provider alias and the subject the provider sends, so a user of the new issuer with a matching subject would sign in as that member. To correct it, create a new organization, or remove the members\' links to the identity provider in Keycloak first',
  ],
])('edit: shows an identity provider change refused with %s', async (_case, refusal, shown) => {
  const service = new MockConsoleService();
  tenantsOf(service).before.update = () => {
    throw refusal;
  };
  const user = userEvent.setup();
  renderAt(`/organizations/${ACME_ID}/edit`, service);
  await openStep(user, 'Identity provider');
  const title = screen.getByRole('textbox', { name: 'Identity provider name' });
  await waitFor(() => expect(title).toHaveValue('Acme Robotics SSO'));
  await user.click(title);
  await user.paste(' v2');
  await saveEdit(user);
  expect(await screen.findByText('Unable to save organization')).toBeVisible();
  expect(screen.getByText(shown)).toBeVisible();
  expect(tenantsOf(service).find(ACME_ID)?.metadata?.version).toBe(1);
});

it.each([
  ['Unavailable', unavailable()],
  ['DeadlineExceeded', new ConnectError('the backend did not answer in time', Code.DeadlineExceeded)],
])('edit: a new issuer answered %s may already be in use for logging in', async (_code, answer) => {
  const service = new MockConsoleService();
  tenantsOf(service).before.update = () => {
    throw answer;
  };
  const user = userEvent.setup();
  renderAt(`/organizations/${ACME_ID}/edit`, service);
  await openStep(user, 'Identity provider');
  const issuer = screen.getByRole('textbox', { name: 'Issuer' });
  await waitFor(() => expect(issuer).toHaveValue('https://sso.example.com/realms/acme-robotics'));
  await user.clear(issuer);
  await user.paste('https://sso.example.com/realms/acme-corp');
  await saveEdit(user);
  // If it landed, Keycloak already uses the new issuer, which the backend's own message (never
  // shown: it embeds raw errors) says too.
  expect(await screen.findByText(`${MAYBE_SAVED} ${ISSUER_MAYBE_SAVED}`)).toBeVisible();
});

it('edit: warns on leaving only when a save would send something', async () => {
  const service = emptyService();
  const organization = addOrganization(service, { name: input.name, domains: input.domains });
  const user = userEvent.setup();
  renderAt(`/organizations/${encodeURIComponent(organization.id)}/edit`, service);
  // Turning off Validate signature alone leaves the provider blank, which a save doesn't send, so
  // Cancel leaves at once, as Save is disabled.
  await openStep(user, 'Identity provider');
  await user.click(screen.getByRole('checkbox', { name: 'Validate signature' }));
  await openStep(user, 'Review');
  expect(screen.getByRole('button', { name: 'Save' })).toBeDisabled();
  await user.click(screen.getByRole('button', { name: 'Cancel' }));
  expect(await screen.findByTestId('organization-configuration-details')).toBeVisible();
  expect(screen.queryByTestId('discard-changes-modal')).not.toBeInTheDocument();

  // Typing into the provider is something a save sends, so Cancel asks first.
  await user.click(screen.getByTestId('organization-actions'));
  await user.click(screen.getByRole('menuitem', { name: 'Edit' }));
  await openStep(user, 'Identity provider');
  await user.click(screen.getByRole('textbox', { name: 'Identity provider name' }));
  await user.paste('Tenant 1 SSO');
  await user.click(screen.getByRole('button', { name: 'Cancel' }));
  expect(await screen.findByTestId('discard-changes-modal')).toBeVisible();
  expect(tenantsOf(service).sent('update')).toEqual([]);
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
  expect(await screen.findByText('Organization frontfix-1 created')).toBeVisible();
  await act(async () => navigate(-1));
  expect(await screen.findByRole('heading', { level: 1, name: 'Clusters' })).toBeVisible();
});

it('create without an identity provider sends none, and Review says so', async () => {
  const service = emptyService();
  const user = userEvent.setup();
  renderAt('/organizations/create', service);
  await user.click(await screen.findByRole('textbox', { name: 'Name' }));
  await user.paste('tenant1');
  await user.click(screen.getByRole('button', { name: 'Next' }));
  await user.click(screen.getByRole('button', { name: 'Next' }));
  const review = screen.getByTestId('organization-configuration-details');
  expect(within(review).getByRole('heading', { name: NO_IDP })).toBeVisible();
  expect(review).toHaveTextContent(NO_IDP_REASON);
  await user.click(screen.getByRole('button', { name: 'Create organization' }));
  expect(await screen.findByText('Organization tenant1 created')).toBeVisible();
  const [sent] = tenantsOf(service).sent('create');
  expect(sent.object?.metadata?.name).toBe('tenant1');
  expect(sent.object?.spec?.domains).toEqual([]);
  expect(sent.object?.spec?.identityProvider).toBeUndefined();
});

it('lists the identity provider by title, warns without one, and shows no status the backend lacks', async () => {
  const service = new MockConsoleService();
  addOrganization(service, { name: 'umbrella-biotech', domains: ['umbrella.example.com'] }, 'u');
  renderAt('/organizations', service);
  const acme = await screen.findByRole('row', { name: /^acme-robotics / });
  expect(acme).toHaveTextContent('Acme Robotics SSO');
  expect(acme).not.toHaveTextContent('https://sso.example.com/realms/acme-robotics');
  const umbrella = screen.getByRole('row', { name: /^umbrella-biotech / });
  // AI grid has none, so the cell says so, as a cluster without a role does, with what that means
  // unless one was set up in Keycloak directly, which the backend doesn't report.
  const missing = within(umbrella).getByTestId('missing-idp-umbrella-biotech');
  expect(missing).toHaveTextContent(NO_IDP);
  expect(within(umbrella).queryByText('—')).not.toBeInTheDocument();
  await userEvent.setup().hover(missing);
  expect(await screen.findByRole('tooltip')).toHaveTextContent(NO_IDP_REASON);
  // The backend's Tenant reports no state (TenantStatus is empty), so the list has no Status column.
  expect(screen.queryByRole('columnheader', { name: /Status/ })).not.toBeInTheDocument();
});

it('the organization page shows its domains and created date, endpoints folded', async () => {
  const service = new MockConsoleService();
  const user = userEvent.setup();
  renderAt(`/organizations/${ACME_ID}`, service);
  const details = await screen.findByTestId('organization-configuration-details');
  expect(details).toHaveTextContent('acme-robotics.example.com');
  expect(details).toHaveTextContent('acme.example.org');
  // The backend's Tenant has no attributes or domain verification to show.
  expect(details).not.toHaveTextContent('Attributes');
  expect(details).not.toHaveTextContent('Verified');
  // Created reads relative, as on every page, with the time itself on the element.
  expect(within(details).getByText(/ ago$/)).toHaveAttribute('datetime', '2026-09-01T09:00:00.000Z');
  const tokenUrl = screen.getByText('https://sso.example.com/realms/acme-robotics/protocol/openid-connect/token');
  expect(tokenUrl).not.toBeVisible();
  await user.click(screen.getByRole('button', { name: 'OIDC endpoints' }));
  expect(tokenUrl).toBeVisible();
});

it.each(['', '/edit'])('loads the other organization when the id in /organizations/:id%s changes', async (suffix) => {
  const service = new MockConsoleService();
  const [acme, globex] = [
    { id: ACME_ID, name: 'acme-robotics' },
    { id: GLOBEX_ID, name: 'globex-research' },
  ];
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
  const organization = { id: ACME_ID };
  const saving = deferred<void>();
  tenantsOf(service).before.update = () => saving.promise;
  const user = userEvent.setup();
  renderAt(`/organizations/${encodeURIComponent(organization.id)}/edit`, service);
  await user.click(await screen.findByRole('textbox', { name: 'Domain 1' }));
  await user.paste('x');
  await saveEdit(user);
  // The steps and the buttons stay put until the save answers.
  expect(screen.getByRole('button', { name: 'Identity provider' })).toBeDisabled();
  expect(screen.getByRole('button', { name: 'Back' })).toBeDisabled();
  expect(screen.getByRole('button', { name: 'Cancel' })).toBeDisabled();
  await act(async () => saving.resolve());
  expect(await screen.findByText('Changes to organization acme-robotics saved')).toBeVisible();
});

it('moves an edit refused for a field to that field, once, and lets the user return to Review', async () => {
  const service = new MockConsoleService();
  const organization = { id: ACME_ID };
  // The backend names the domain by its proto path; the form shows it next to Domain 1.
  tenantsOf(service).before.update = () => {
    throw fieldViolations('The organization is invalid.', { 'spec.domains[0]': 'The domain is already taken.' });
  };
  const user = userEvent.setup();
  renderAt(`/organizations/${encodeURIComponent(organization.id)}/edit`, service);
  await user.click(await screen.findByRole('textbox', { name: 'Domain 1' }));
  await user.paste('x');
  await openStep(user, 'Identity provider');
  await saveEdit(user);
  // Back on the Organization details step, with the server's message next to the domain.
  expect(await screen.findByRole('textbox', { name: 'Domain 1' })).toHaveAttribute('aria-invalid', 'true');
  expect(screen.getByText('The domain is already taken.')).toBeVisible();
  // Going back to Review stays there: the move happens once per refused save.
  await openStep(user, 'Review');
  expect(screen.getByRole('button', { name: 'Save' })).toBeVisible();
  expect(screen.queryByRole('textbox', { name: 'Domain 1' })).not.toBeInTheDocument();
});

it('edit: an organization without an identity provider keeps none while the step stays blank', async () => {
  const service = emptyService();
  const organization = addOrganization(service, { name: input.name, domains: input.domains });
  const user = userEvent.setup();
  renderAt(`/organizations/${encodeURIComponent(organization.id)}/edit`, service);
  await openStep(user, 'Identity provider');
  expect(screen.getByRole('textbox', { name: 'Client ID' })).toHaveValue('');
  // Turning off Validate signature alone leaves the provider blank: nothing to send, nothing to save.
  await user.click(screen.getByRole('checkbox', { name: 'Validate signature' }));
  await openStep(user, 'Review');
  expect(screen.getByRole('heading', { name: NO_IDP })).toBeVisible();
  expect(screen.getByRole('button', { name: 'Save' })).toBeDisabled();
  await openStep(user, 'Organization details');
  await user.click(screen.getByRole('textbox', { name: 'Domain 1' }));
  await user.paste('x');
  await saveEdit(user);
  expect(await screen.findByText(`Changes to organization ${organization.name} saved`)).toBeVisible();
  const [update] = tenantsOf(service).sent('update');
  expect(update.updateMask?.paths).toEqual(['spec.domains']);
  expect(update.object?.spec?.identityProvider).toBeUndefined();
});

it('edit: adds an identity provider to an organization without one, validated as on create', async () => {
  const service = emptyService();
  const organization = addOrganization(service, { name: input.name, domains: input.domains });
  const user = userEvent.setup();
  renderAt(`/organizations/${encodeURIComponent(organization.id)}/edit`, service);
  await openStep(user, 'Identity provider');
  // A partly filled provider isn't valid, as on create.
  await user.click(screen.getByRole('textbox', { name: 'Identity provider name' }));
  await user.paste('Tenant 1 SSO');
  expect(screen.getByRole('button', { name: 'Review' })).toBeDisabled();
  // Without a provider there are no users to match, so the issuer has its example, as on create.
  expect(screen.getByText('For example https://sso.example.com/realms/acme.')).toBeVisible();
  expect(screen.queryByText(/The issuer can be edited only until/)).not.toBeInTheDocument();
  await fillRequiredIdp(user, requiredIdp);
  await saveEdit(user);
  expect(await screen.findByText(`Changes to organization ${organization.name} saved`)).toBeVisible();

  const [update] = tenantsOf(service).sent('update');
  expect(update.updateMask?.paths).toEqual(['spec.identity_provider']);
  expect(update.object?.spec?.identityProvider?.title).toBe('Tenant 1 SSO');
  expect(update.object?.spec?.identityProvider?.config?.issuer).toBe('https://idp.example.com');
  expect(update.object?.spec?.domains).toEqual([]);
  expect(tenantsOf(service).find(organization.id)?.spec?.domains).toEqual(input.domains);
  expect(tenantsOf(service).find(organization.id)?.spec?.identityProvider?.config?.clientSecretSecretName).toBe(
    'secret',
  );
  expect(await screen.findByTestId('organization-configuration-details')).toHaveTextContent('Tenant 1 SSO');
});

it("edit: shows an add refused for a provider this API did not create in the backend's words", async () => {
  const service = emptyService();
  const organization = addOrganization(service, { name: input.name, domains: input.domains });
  // Made in Keycloak directly, with a provider of its own under the organization's alias.
  tenantsOf(service).before.update = () => {
    throw new ConnectError(
      'the organization already has identity provider "tenant1", which this API didn\'t create; manage it in Keycloak, or remove it there before adding one here',
      Code.FailedPrecondition,
    );
  };
  const user = userEvent.setup();
  renderAt(`/organizations/${encodeURIComponent(organization.id)}/edit`, service);
  await openStep(user, 'Identity provider');
  await fillRequiredIdp(user, requiredIdp);
  await saveEdit(user);
  expect(await screen.findByText('Unable to save organization')).toBeVisible();
  expect(
    screen.getByText(
      'the organization already has identity provider "tenant1", which this API didn\'t create; manage it in Keycloak, or remove it there before adding one here',
    ),
  ).toBeVisible();
  expect(tenantsOf(service).find(organization.id)?.spec?.identityProvider).toBeUndefined();
});

it('the organization page says when an organization has no identity provider', async () => {
  const service = emptyService();
  const organization = addOrganization(service, { name: input.name, domains: input.domains });
  renderAt(`/organizations/${encodeURIComponent(organization.id)}`, service);
  const details = await screen.findByTestId('organization-configuration-details');
  // The backend reports only a provider it created, so the page can't say its users cannot log in:
  // one set up in Keycloak directly is not reported.
  expect(within(details).getByRole('heading', { name: NO_IDP })).toBeVisible();
  expect(details).toHaveTextContent(NO_IDP_REASON);
  expect(within(details).queryByRole('button', { name: 'OIDC endpoints' })).not.toBeInTheDocument();
});

it('reloads an organization after a stale delete from its page, keeping the typed name, so a retry succeeds', async () => {
  const service = new MockConsoleService();
  const organization = { id: ACME_ID, name: 'acme-robotics' };
  const user = userEvent.setup();
  renderAt(`/organizations/${organization.id}`, service);
  await user.click(await screen.findByTestId('organization-actions'));
  await user.click(screen.getByRole('menuitem', { name: 'Delete' }));
  const modal = await screen.findByTestId('delete-organization-modal');
  await user.click(within(modal).getByTestId('delete-modal-input'));
  await user.paste(organization.name);
  // Someone else saves the organization while the dialog is open.
  tenantsOf(service).bump(organization.id);
  await user.click(within(modal).getByRole('button', { name: 'Delete' }));
  expect(
    await within(modal).findByText(
      'This organization was changed after this dialog opened. The latest version is now shown. Review it and try again.',
    ),
  ).toBeVisible();
  expect(within(modal).getByTestId('delete-modal-input')).toHaveValue(organization.name);
  await user.click(within(modal).getByRole('button', { name: 'Delete' }));
  expect(await screen.findByText(`Organization ${organization.name} deleted`)).toBeVisible();
  expect(storedIds(service)).not.toContain(organization.id);
});

it('keeps the delete dialog busy until the reloaded organization is in, and says when the reload fails', async () => {
  const service = new MockConsoleService();
  const organization = { id: ACME_ID, name: 'acme-robotics' };
  const fake = tenantsOf(service);
  const user = userEvent.setup();
  renderAt('/organizations', service);
  await user.click(await screen.findByRole('button', { name: `Actions for ${organization.name}` }));
  await user.click(screen.getByRole('menuitem', { name: 'Delete' }));
  const modal = await screen.findByTestId('delete-organization-modal');
  await user.click(within(modal).getByTestId('delete-modal-input'));
  await user.paste(organization.name);
  fake.bump(organization.id);
  // The list page reads no single organization, so the dialog's reload is the first Get.
  const reload = deferred<void>();
  fake.before.get = () => reload.promise;
  await user.click(within(modal).getByRole('button', { name: 'Delete' }));
  await waitFor(() => expect(fake.sent('get')).toHaveLength(1));
  // The reload is still out: Delete stays busy, so no retry with the stale version.
  expect(within(modal).getByRole('button', { name: /Delete/ })).toBeDisabled();
  await user.type(within(modal).getByTestId('delete-modal-input'), '{Enter}');
  expect(fake.sent('delete')).toHaveLength(1);
  await act(async () => {
    reload.resolve();
  });
  expect(within(modal).getByRole('button', { name: 'Delete' })).toBeEnabled();

  // A second stale delete whose reload fails says so.
  fake.bump(organization.id);
  fake.before.get = () => {
    throw unavailable();
  };
  await user.click(within(modal).getByRole('button', { name: 'Delete' }));
  expect(await within(modal).findByText(`Unable to reload the latest version: ${UNAVAILABLE}`)).toBeVisible();
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

  const organization = { id: ACME_ID, name: 'acme-robotics' };
  renderAt(`/organizations/${organization.id}`, service);
  await user.click(await screen.findByTestId('organization-actions'));
  await user.click(screen.getByRole('menuitem', { name: 'Delete' }));
  const modal = await screen.findByTestId('delete-organization-modal');
  expect(within(modal).getByRole('textbox', { name: `Type ${organization.name} to confirm deletion:` })).toBeVisible();
});

it('edit: an identity provider saved without a JWKS URL is kept, and the domains still save', async () => {
  const service = new MockConsoleService();
  const organization = { id: ACME_ID };
  // Saved before the JWKS rule, with Validate signature on. The edit can't change the provider and
  // leaves it out of the save, so the rule doesn't block it.
  const config = tenantsOf(service).find(ACME_ID)?.spec?.identityProvider?.config;
  if (!config) throw new Error('acme-robotics has no identity provider');
  config.jwksUrl = '';
  config.validateSignature = true;
  const user = userEvent.setup();
  renderAt(`/organizations/${encodeURIComponent(organization.id)}/edit`, service);
  await user.click(await screen.findByRole('textbox', { name: 'Domain 1' }));
  await user.paste('x');
  await saveEdit(user);
  expect(await screen.findByText('Changes to organization acme-robotics saved')).toBeVisible();
  expect(tenantsOf(service).sent('update')[0].object?.spec?.identityProvider).toBeUndefined();
});
