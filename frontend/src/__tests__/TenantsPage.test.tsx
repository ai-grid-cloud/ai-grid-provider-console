import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { act, fireEvent, render, screen, waitFor, within } from '@testing-library/react';
import { MockConsoleService, seedTenants, validateAlias, validateDomain } from '../api/MockConsoleService';
import { ServiceError } from '../api/ConsoleService';
import type { Tenant } from '../api/types';
import { TenantsPage, parseDomains } from '../pages/TenantsPage';

const row = (name: string) => screen.getByTestId(`tenant-${name}`).closest('tr') as HTMLElement;
const findTenant = (name: string) => screen.findByTestId(`tenant-${name}`);
const queryTenant = (name: string) => screen.queryByTestId(`tenant-${name}`);
const admin = (service = new MockConsoleService()) => <TenantsPage service={service} canEdit />;
const actionsToggle = (name: string) => screen.getByRole('button', { name: `Actions for ${name}` });
const runAction = async (name: string, item: string) => {
  fireEvent.click(actionsToggle(name));
  const menuItem = await screen.findByRole('menuitem', { name: item });
  await act(async () => {
    fireEvent.click(menuItem);
  });
};
const pageSummary = () => screen.getByRole('button', { name: /of \d+/ });
const typeInto = (label: string, value: string) => fireEvent.change(screen.getByLabelText(label, { exact: false }), { target: { value } });

describe('TenantsPage', () => {
  it('lists the tenants with alias, domains and enabled state', async () => {
    render(admin());
    await findTenant('acme-robotics');
    const acme = row('acme-robotics');
    expect(within(acme).getByText('acme-robotics.example.com')).toBeInTheDocument();
    expect(within(acme).getByText('acme.example.org')).toBeInTheDocument();
    expect(within(acme).getAllByText('verified')).toHaveLength(1);
    expect(within(row('globex-research')).getByText('globex')).toBeInTheDocument();
    expect(screen.getByTestId('enabled-umbrella-biotech')).toHaveTextContent('Disabled');
    expect(screen.getByTestId('enabled-acme-robotics')).toHaveTextContent('Enabled');
    expect(within(row('initech-labs')).getByText('-')).toBeInTheDocument();
    expect(pageSummary()).toHaveTextContent('1 - 6 of 6');
  });

  it('searches by name or domain through the service', async () => {
    const service = new MockConsoleService();
    const spy = vi.spyOn(service, 'listTenants');
    render(admin(service));
    await findTenant('acme-robotics');

    const input = screen.getByRole('textbox', { name: 'Search tenants' });
    fireEvent.change(input, { target: { value: 'example.org' } });
    fireEvent.click(screen.getByRole('button', { name: 'Search' }));

    await waitFor(() => expect(queryTenant('globex-research')).not.toBeInTheDocument());
    expect(queryTenant('acme-robotics')).toBeInTheDocument();
    expect(spy).toHaveBeenLastCalledWith({ offset: 0, limit: 10, search: 'example.org' });

    fireEvent.change(input, { target: { value: 'nothing-here' } });
    fireEvent.click(screen.getByRole('button', { name: 'Search' }));
    expect(await screen.findByText('No tenants match')).toBeInTheDocument();
  });

  it('pages with offset and limit', async () => {
    const service = new MockConsoleService();
    // Twelve tenants: the six seeds plus six more, so there is a second page of ten.
    service.tenants = [...seedTenants(), ...seedTenants().map((t) => ({ ...t, id: `${t.id.slice(0, -1)}f`, name: `z-${t.name}`, alias: `z-${t.alias}`, domains: [], domainDetails: [] }))];
    const spy = vi.spyOn(service, 'listTenants');
    render(admin(service));
    await findTenant('acme-robotics');
    expect(pageSummary()).toHaveTextContent('1 - 10 of 12');
    expect(queryTenant('z-wayne-aerospace')).not.toBeInTheDocument();

    fireEvent.click(screen.getByRole('button', { name: 'Go to next page' }));
    await findTenant('z-wayne-aerospace');
    expect(spy).toHaveBeenLastCalledWith({ offset: 10, limit: 10, search: undefined });
    expect(pageSummary()).toHaveTextContent('11 - 12 of 12');
    expect(queryTenant('acme-robotics')).not.toBeInTheDocument();

    fireEvent.click(pageSummary());
    fireEvent.click(await screen.findByRole('menuitem', { name: '20 per page' }));
    await findTenant('acme-robotics');
    expect(spy).toHaveBeenLastCalledWith({ offset: 0, limit: 20, search: undefined });
    expect(pageSummary()).toHaveTextContent('1 - 12 of 12');
  });

  it('creates a tenant from the modal and shows it', async () => {
    const service = new MockConsoleService();
    const spy = vi.spyOn(service, 'createTenant');
    render(admin(service));
    await findTenant('acme-robotics');

    fireEvent.click(screen.getByRole('button', { name: 'Create tenant' }));
    const dialog = await screen.findByRole('dialog');
    typeInto('Name', 'stark-industries');
    typeInto('Description', 'Stark Industries');
    typeInto('Domains', 'Stark.example.com, *.stark.example.org');
    await act(async () => {
      fireEvent.click(within(dialog).getByRole('button', { name: 'Create' }));
    });

    await waitFor(() => expect(screen.queryByRole('dialog')).not.toBeInTheDocument());
    expect(spy).toHaveBeenCalledWith({ name: 'stark-industries', alias: undefined, description: 'Stark Industries', domains: ['Stark.example.com', '*.stark.example.org'] });
    const stark = await findTenant('stark-industries');
    expect(within(stark.closest('tr') as HTMLElement).getByText('stark.example.com')).toBeInTheDocument();
    const created = service.tenants.find((t) => t.name === 'stark-industries')!;
    expect(created.alias).toBe('stark-industries');
    expect(created.enabled).toBe(true);
    expect(created.domains).toEqual(['stark.example.com', '*.stark.example.org']);
  });

  it('shows the 409 message from Keycloak in the modal for a duplicate name', async () => {
    render(admin());
    await findTenant('acme-robotics');
    fireEvent.click(screen.getByRole('button', { name: 'Create tenant' }));
    const dialog = await screen.findByRole('dialog');
    typeInto('Name', 'acme-robotics');
    await act(async () => {
      fireEvent.click(within(dialog).getByRole('button', { name: 'Create' }));
    });

    expect(await within(dialog).findByText('Tenant could not be created')).toBeInTheDocument();
    expect(within(dialog).getByText('A organization with the same name already exists.')).toBeInTheDocument();
    expect(screen.getByRole('dialog')).toBeInTheDocument();
  });

  it('shows the domain validation message and keeps the form', async () => {
    render(admin());
    await findTenant('acme-robotics');
    fireEvent.click(screen.getByRole('button', { name: 'Create tenant' }));
    const dialog = await screen.findByRole('dialog');
    typeInto('Name', 'new-tenant');
    typeInto('Domains', 'not a domain');
    await act(async () => {
      fireEvent.click(within(dialog).getByRole('button', { name: 'Create' }));
    });
    expect(await within(dialog).findByText('Invalid domain format: not a domain')).toBeInTheDocument();
    expect(screen.getByLabelText('Name', { exact: false })).toHaveValue('new-tenant');
  });

  it('edits name, description and domains; the alias is read-only', async () => {
    const service = new MockConsoleService();
    const spy = vi.spyOn(service, 'updateTenant');
    render(admin(service));
    await findTenant('globex-research');
    await runAction('globex-research', 'Edit');
    const dialog = await screen.findByRole('dialog');
    expect(screen.getByLabelText('Alias', { exact: false })).toBeDisabled();
    expect(screen.getByLabelText('Alias', { exact: false })).toHaveValue('globex');
    typeInto('Description', 'Globex Research, renamed');
    typeInto('Domains', 'globex.example.com\nlabs.globex.example.com');
    await act(async () => {
      fireEvent.click(within(dialog).getByRole('button', { name: 'Save' }));
    });
    await waitFor(() => expect(screen.queryByRole('dialog')).not.toBeInTheDocument());
    expect(spy).toHaveBeenCalledWith('8d2e7b31-0c4f-4a9d-b5e6-7f8a9b0c1d2e', {
      description: 'Globex Research, renamed',
      domains: ['globex.example.com', 'labs.globex.example.com'],
    });
    expect(await screen.findByText('labs.globex.example.com')).toBeInTheDocument();
    // The verified flag of the domain that stayed is kept, as the fake keeps it.
    expect(service.tenants.find((t) => t.alias === 'globex')?.domainDetails[0].verified).toBe(true);
  });

  it('disables and enables a tenant from the row actions', async () => {
    const service = new MockConsoleService();
    render(admin(service));
    await findTenant('acme-robotics');
    await runAction('acme-robotics', 'Disable');
    await waitFor(() => expect(screen.getByTestId('enabled-acme-robotics')).toHaveTextContent('Disabled'));
    await runAction('umbrella-biotech', 'Enable');
    await waitFor(() => expect(screen.getByTestId('enabled-umbrella-biotech')).toHaveTextContent('Enabled'));
  });

  it('deletes a tenant after confirmation', async () => {
    const service = new MockConsoleService();
    const spy = vi.spyOn(service, 'deleteTenant');
    render(admin(service));
    await findTenant('initech-labs');
    await runAction('initech-labs', 'Delete');
    const dialog = await screen.findByRole('dialog');
    expect(within(dialog).getByText('Delete tenant initech-labs?')).toBeInTheDocument();
    fireEvent.click(within(dialog).getByRole('button', { name: 'Cancel' }));
    await waitFor(() => expect(screen.queryByRole('dialog')).not.toBeInTheDocument());
    expect(spy).not.toHaveBeenCalled();

    await runAction('initech-labs', 'Delete');
    const confirm = await screen.findByRole('dialog');
    await act(async () => {
      fireEvent.click(within(confirm).getByRole('button', { name: 'Delete' }));
    });
    await waitFor(() => expect(queryTenant('initech-labs')).not.toBeInTheDocument());
    expect(spy).toHaveBeenCalledWith('c5a4d3e2-f1b0-4987-a6c5-d4e3f2a1b0c9');
    expect(pageSummary()).toHaveTextContent('1 - 5 of 5');
  });

  it('shows the backend error with the right verb when a row action fails', async () => {
    const service = new MockConsoleService();
    service.deleteTenant = async () => {
      throw new ServiceError(412, 'Keycloak realm "ai-grid": Realm not found.');
    };
    render(admin(service));
    await findTenant('initech-labs');
    await runAction('initech-labs', 'Delete');
    const dialog = await screen.findByRole('dialog');
    await act(async () => {
      fireEvent.click(within(dialog).getByRole('button', { name: 'Delete' }));
    });
    expect(await screen.findByText('Tenant initech-labs could not be deleted')).toBeInTheDocument();
    // The wrapping text is the console's proposal; only Keycloak's part is fixed.
    expect(screen.getByText(/Realm not found\./)).toBeInTheDocument();
    expect(queryTenant('initech-labs')).toBeInTheDocument();
  });

  it('moves to the last page when a delete empties the current one', async () => {
    const service = new MockConsoleService();
    service.tenants = [...seedTenants(), ...seedTenants().map((t) => ({ ...t, id: `${t.id.slice(0, -1)}f`, name: `z-${t.name}`, alias: `z-${t.alias}`, domains: [], domainDetails: [] }))];
    const only = { ...seedTenants()[0], id: '00000000-0000-4000-8000-0000000000aa', name: 'zz-last', alias: 'zz-last', domains: [], domainDetails: [] };
    service.tenants = [...service.tenants.slice(0, 10), only];
    render(admin(service));
    await findTenant('acme-robotics');
    fireEvent.click(screen.getByRole('button', { name: 'Go to next page' }));
    await findTenant('zz-last');
    expect(pageSummary()).toHaveTextContent('11 - 11 of 11');

    await runAction('zz-last', 'Delete');
    const dialog = await screen.findByRole('dialog');
    await act(async () => {
      fireEvent.click(within(dialog).getByRole('button', { name: 'Delete' }));
    });
    await findTenant('acme-robotics');
    expect(pageSummary()).toHaveTextContent('1 - 10 of 10');
    expect(screen.queryByText('No tenants')).not.toBeInTheDocument();
  });

  it('shows a load error and the not-implemented state', async () => {
    const service = new MockConsoleService();
    service.listTenants = async () => {
      throw new ServiceError(503, 'the AI Grid backend is unavailable; try again');
    };
    render(admin(service));
    expect(await screen.findByText('Tenants could not be loaded')).toBeInTheDocument();
    expect(screen.getByText('the AI Grid backend is unavailable; try again')).toBeInTheDocument();
  });

  it('ignores a list response that arrives after a newer search started', async () => {
    const service = new MockConsoleService();
    const real = service.listTenants;
    const pending: { params: { search?: string } | undefined; resolve: () => void }[] = [];
    service.listTenants = (params) =>
      new Promise((resolve, reject) => {
        pending.push({ params, resolve: () => void real(params).then(resolve, reject) });
      });
    render(admin(service));
    await waitFor(() => expect(pending).toHaveLength(1)); // the initial load, still pending

    const input = screen.getByRole('textbox', { name: 'Search tenants' });
    fireEvent.change(input, { target: { value: 'globex' } });
    fireEvent.click(screen.getByRole('button', { name: 'Search' }));
    await waitFor(() => expect(pending).toHaveLength(2));
    expect(pending[1].params?.search).toBe('globex');

    // The newer search answers first, then the stale initial load.
    await act(async () => pending[1].resolve());
    await findTenant('globex-research');
    expect(queryTenant('acme-robotics')).not.toBeInTheDocument();
    await act(async () => pending[0].resolve());
    await act(async () => {
      await new Promise((r) => setTimeout(r, 0));
    });
    expect(queryTenant('acme-robotics')).not.toBeInTheDocument();
    expect(queryTenant('globex-research')).toBeInTheDocument();
    expect(pageSummary()).toHaveTextContent('1 - 1 of 1');
  });

  it('reloads with the search in force when a mutation finishes, not the one it started with', async () => {
    const service = new MockConsoleService();
    const listSpy = vi.spyOn(service, 'listTenants');
    let finishUpdate: () => void = () => undefined;
    const realUpdate = service.updateTenant;
    service.updateTenant = (id, patch) => new Promise((resolve) => (finishUpdate = () => void realUpdate(id, patch).then(resolve)));
    render(admin(service));
    await findTenant('acme-robotics');

    await runAction('acme-robotics', 'Disable'); // update pending
    const input = screen.getByRole('textbox', { name: 'Search tenants' });
    fireEvent.change(input, { target: { value: 'umbrella' } });
    fireEvent.click(screen.getByRole('button', { name: 'Search' }));
    await findTenant('umbrella-biotech');
    await act(async () => finishUpdate());
    await waitFor(() => expect(listSpy).toHaveBeenLastCalledWith({ offset: 0, limit: 10, search: 'umbrella' }));
    expect(queryTenant('umbrella-biotech')).toBeInTheDocument();
    expect(queryTenant('acme-robotics')).not.toBeInTheDocument();
    expect(service.tenants.find((t) => t.name === 'acme-robotics')?.enabled).toBe(false);
  });

  it('hides the actions and the create button from a viewer', async () => {
    const service = new MockConsoleService({ username: 'viewer', groups: [], isProviderAdmin: false });
    render(<TenantsPage service={service} canEdit={false} />);
    await findTenant('acme-robotics');
    expect(screen.queryByRole('button', { name: 'Create tenant' })).not.toBeInTheDocument();
    expect(screen.queryByRole('button', { name: /Actions for/ })).not.toBeInTheDocument();
    // The service enforces it too, like the fake backend does for a denied token.
    await expect(service.createTenant({ name: 'x' })).rejects.toMatchObject({ status: 403 });
    await expect(service.deleteTenant('c5a4d3e2-f1b0-4987-a6c5-d4e3f2a1b0c9')).rejects.toMatchObject({ status: 403 });
  });
});

/**
 * The browser mock must not drift from the fake backend's fixture: same
 * organizations, same aliases, domains, metadata, attributes and enabled flags.
 */
describe('seedTenants mirrors mock/fixtures/tenants.json', () => {
  type FixtureDomain = { name: string; verified?: boolean; identityProviderAlias?: string; autoRedirect?: boolean };
  type Fixture = {
    id: string;
    name: string;
    alias?: string;
    enabled?: boolean;
    description?: string;
    attributes?: Record<string, string>;
    domains?: string[];
    domainDetails?: FixtureDomain[];
  };
  const fixture = JSON.parse(readFileSync(join(process.cwd(), '..', 'mock', 'fixtures', 'tenants.json'), 'utf8')) as { tenants: Fixture[] };

  it('has the same organizations with the same fields', () => {
    const seeds = new Map(seedTenants().map((t) => [t.id, t]));
    expect([...seeds.keys()].sort()).toEqual(fixture.tenants.map((t) => t.id).sort());
    for (const f of fixture.tenants) {
      const s = seeds.get(f.id)!;
      const expected: Tenant = {
        id: f.id,
        name: f.name,
        alias: f.alias ?? f.name,
        enabled: f.enabled ?? true, // the BFF reads an absent enabled as Keycloak's default
        description: f.description ?? '',
        attributes: f.attributes ?? {},
        domains: f.domains ?? [],
        domainDetails: (f.domainDetails ?? []).map((d) => ({
          name: d.name,
          verified: d.verified ?? false,
          autoRedirect: d.autoRedirect ?? false,
          ...(d.identityProviderAlias ? { identityProviderAlias: d.identityProviderAlias } : {}),
        })),
      };
      expect(s, f.name).toEqual(expected);
      expect(s.domains, f.name).toEqual(s.domainDetails.map((d) => d.name));
    }
  });
});

describe('MockConsoleService tenants', () => {
  it('applies Keycloak rules: defaults, uniqueness, alias immutability, 404', async () => {
    const service = new MockConsoleService();
    await expect(service.getTenant('nope')).rejects.toMatchObject({ status: 404, message: "object with identifier 'nope' not found" });
    await expect(service.createTenant({ name: '' })).rejects.toMatchObject({ status: 422, message: 'Name can not be null' });
    await expect(service.createTenant({ name: 'Acme Robotics' })).rejects.toMatchObject({ status: 422, message: 'Name cannot be used as alias: Empty Space not allowed.' });
    await expect(service.createTenant({ name: 'x', alias: 'a/b' })).rejects.toMatchObject({ status: 422, message: "Character '/' not allowed." });
    await expect(service.createTenant({ name: 'acme-robotics' })).rejects.toMatchObject({ status: 409, message: 'A organization with the same name already exists.' });
    await expect(service.createTenant({ name: 'other', alias: 'globex' })).rejects.toMatchObject({ status: 409, message: 'A organization with the same alias already exists' });
    await expect(service.createTenant({ name: 'other', domains: ['GLOBEX.example.com'] })).rejects.toMatchObject({
      status: 422,
      message: 'Domain globex.example.com is already linked to organization globex-research in realm ai-grid',
    });
    await expect(service.createTenant({ name: 'other', domains: ['*.com'] })).rejects.toMatchObject({ status: 422, message: "Domain must have at least 2 parts (e.g. 'example.com'): com" });
    // A taken name wins over a bad domain, as Keycloak creates the row before it looks at the domains.
    await expect(service.createTenant({ name: 'acme-robotics', alias: 'other', domains: ['not a domain'] })).rejects.toMatchObject({ status: 409 });
    await expect(service.createTenant({ name: 'other', domains: [' Not A Domain '] })).rejects.toMatchObject({ status: 422, message: 'Invalid domain format: not a domain' });

    const created = await service.createTenant({ name: 'Acme EU', alias: 'acme-eu', enabled: false, domains: ['EU.acme.example.com', 'eu.acme.example.com'] });
    expect(created).toMatchObject({ alias: 'acme-eu', enabled: false, domains: ['eu.acme.example.com'], description: '', attributes: {} });
    expect(created.id).toMatch(/^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/);

    await expect(service.updateTenant(created.id, { alias: 'other' })).rejects.toMatchObject({ status: 422, message: 'Cannot change the alias' });
    await expect(service.updateTenant(created.id, { alias: 'acme-eu', enabled: true })).resolves.toMatchObject({ enabled: true });
    await expect(service.updateTenant(created.id, { name: 'globex-research' })).rejects.toMatchObject({ status: 409 });
    await expect(service.updateTenant(created.id, { name: 'globex.example.com' })).rejects.toMatchObject({ status: 409 });
    await expect(service.updateTenant(created.id, { name: 'eu.acme.example.com' })).rejects.toMatchObject({ status: 409 }); // its own domain too
    await expect(service.updateTenant(created.id, { domains: ['globex.example.com'] })).rejects.toMatchObject({ status: 422 });
    const cleared = await service.updateTenant(created.id, { domains: [], attributes: {} });
    expect(cleared.domains).toEqual([]);
    await service.deleteTenant(created.id);
    await expect(service.deleteTenant(created.id)).rejects.toMatchObject({ status: 404 });
    // The domain is free again after the delete.
    await expect(service.createTenant({ name: 'acme-eu-2', domains: ['eu.acme.example.com'] })).resolves.toMatchObject({ domains: ['eu.acme.example.com'] });
  });

  it('treats % and _ in a search as literal characters, like the fake backend', async () => {
    const service = new MockConsoleService();
    await service.createTenant({ name: 'under_score', domains: ['100%.example.com'] });
    const names = async (search: string) => (await service.listTenants({ search })).items.map((t) => t.name).join(',');
    await expect(names('r_s')).resolves.toBe('under_score');
    await expect(names('r%s')).resolves.toBe('');
    await expect(names('_')).resolves.toBe('under_score');
    await expect(names('%')).resolves.toBe('under_score');
    await expect(names('100%')).resolves.toBe('under_score');
    await expect(names('a_c')).resolves.toBe('');
    await expect(names('%ex%')).resolves.toBe('');
  });

  it('validates domains and aliases with the fake backend messages', () => {
    expect(validateDomain('acme.example.com')).toBeUndefined();
    expect(validateDomain('localhost')).toBeUndefined();
    expect(validateDomain('*.acme.example.org')).toBeUndefined();
    expect(validateDomain('')).toBe('Domain name cannot be empty');
    expect(validateDomain('not a domain')).toBe('Invalid domain format: not a domain');
    expect(validateDomain('acme.*.example.com')).toBe('Wildcard domain must start with the wildcard');
    expect(validateDomain('acme.*.*.com')).toBe('Wildcard domain must start with the wildcard');
    expect(validateDomain('acme*.example.com')).toBe('Wildcard domain must start with the wildcard');
    expect(validateDomain('*.*.example.com')).toBe('Multiple wildcards are not allowed: *.*.example.com');
    expect(validateDomain('*.')).toBe('Wildcard domain must specify a base domain: *.');
    expect(validateDomain('*acme.example.com')).toBeUndefined();
    expect(validateDomain('ac*me.example.com')).toBeUndefined();
    expect(validateDomain('bücher.example')).toBeUndefined();
    expect(validateDomain('a+b.example.com')).toBeUndefined();
    expect(validateDomain('[192.0.2.1]')).toBeUndefined();
    expect(validateDomain('-a.example.com')).toBe('Invalid domain format: -a.example.com');
    expect(validateDomain('a-.example.com')).toBe('Invalid domain format: a-.example.com');
    expect(validateDomain('acme.example.com.')).toBe('Invalid domain format: acme.example.com.');
    expect(validateDomain(`${'a'.repeat(64)}.example.com`)).toBe(`Invalid domain format: ${'a'.repeat(64)}.example.com`);
    expect(validateDomain('*.com')).toBe("Domain must have at least 2 parts (e.g. 'example.com'): com");
    expect(validateDomain('*.a.b.c.d.e.f.g.h.i.j.k')).toBe('Domain has too many parts (max 10 allowed): a.b.c.d.e.f.g.h.i.j.k');
    expect(validateAlias('acme-eu')).toBeUndefined();
    expect(validateAlias('acme eu')).toBe('Empty Space not allowed.');
    expect(validateAlias('acme@eu')).toBe("Character '@' not allowed.");
    expect(parseDomains('a.example.com, b.example.com\n\n c.example.com ')).toEqual(['a.example.com', 'b.example.com', 'c.example.com']);
  });
});
