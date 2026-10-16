import { useCallback, useEffect, useRef, useState } from 'react';
import {
  Alert,
  Button,
  Checkbox,
  EmptyState,
  EmptyStateBody,
  Form,
  FormGroup,
  FormHelperText,
  HelperText,
  HelperTextItem,
  Label,
  MenuToggle,
  Modal,
  ModalBody,
  ModalFooter,
  ModalHeader,
  Pagination,
  SearchInput,
  Spinner,
  Stack,
  StackItem,
  TextArea,
  TextInput,
  Title,
  Toolbar,
  ToolbarContent,
  ToolbarItem,
} from '@patternfly/react-core';
import { EllipsisVIcon } from '@patternfly/react-icons';
import { ActionsColumn, Table, Tbody, Td, Th, Thead, Tr } from '@patternfly/react-table';
import type { ConsoleService } from '../api/ConsoleService';
import type { Tenant, TenantPage as TenantPageData } from '../api/types';
import { LoadError } from '../components/LoadError';

type Props = {
  service: ConsoleService;
  /**
   * Whether the signed-in user may create, edit and delete tenants (a
   * provider admin). The backend still authorizes every write; this only
   * shows or hides the actions.
   */
  canEdit: boolean;
};

export const PER_PAGE_OPTIONS = [10, 20, 50].map((n) => ({ title: String(n), value: n }));

/** Splits the domains field: one per line or comma-separated, blanks dropped. */
export const parseDomains = (text: string): string[] =>
  text
    .split(/[\n,]/)
    .map((d) => d.trim())
    .filter(Boolean);

type FormValues = { name: string; alias: string; description: string; domains: string };

const emptyForm: FormValues = { name: '', alias: '', description: '', domains: '' };

const formFor = (t: Tenant): FormValues => ({ name: t.name, alias: t.alias, description: t.description, domains: t.domains.join('\n') });

type Editing = { mode: 'create' } | { mode: 'edit'; tenant: Tenant };

export const TenantsPage: React.FC<Props> = ({ service, canEdit }) => {
  const [page, setPage] = useState<TenantPageData | undefined>();
  const [error, setError] = useState<Error | undefined>();
  const [offset, setOffset] = useState(0);
  const [limit, setLimit] = useState(10);
  const [search, setSearch] = useState('');
  const [searchDraft, setSearchDraft] = useState('');
  const [busy, setBusy] = useState<string | undefined>();
  const [actionError, setActionError] = useState<{ name: string; verb: string; error: Error } | undefined>();
  const [editing, setEditing] = useState<Editing | undefined>();
  const [form, setForm] = useState<FormValues>(emptyForm);
  const [formError, setFormError] = useState<Error | undefined>();
  const [saving, setSaving] = useState(false);
  const [deleting, setDeleting] = useState<Tenant | undefined>();

  // Every load gets a generation number; a response that arrives after a
  // newer load started is dropped, so an earlier search or page cannot
  // overwrite the one the controls show.
  const generation = useRef(0);
  const load = useCallback(async () => {
    const mine = ++generation.current;
    const current = () => mine === generation.current;
    try {
      const result = await service.listTenants({ offset, limit, search: search || undefined });
      if (!current()) {
        return;
      }
      if (result.items.length === 0 && result.meta.total > 0 && offset > 0) {
        // The page emptied (a delete, a narrower search): move to the last page that exists.
        setOffset(Math.floor((result.meta.total - 1) / limit) * limit);
        return;
      }
      setPage(result);
      setError(undefined);
    } catch (e) {
      if (!current()) {
        return;
      }
      setError(e instanceof Error ? e : new Error(String(e)));
      setPage((p) => p ?? { items: [], meta: { size: 0, total: 0, offset, limit } });
    }
  }, [service, offset, limit, search]);
  // Mutations reload through the ref so they use the search and page the
  // user is on when the mutation finishes, not the ones captured when it
  // started.
  const loadRef = useRef(load);
  loadRef.current = load;

  useEffect(() => {
    void load();
  }, [load]);

  const runAction = async (t: Tenant, verb: string, action: () => Promise<unknown>) => {
    setBusy(t.id);
    setActionError(undefined);
    try {
      await action();
      await loadRef.current();
    } catch (e) {
      setActionError({ name: t.name, verb, error: e instanceof Error ? e : new Error(String(e)) });
    } finally {
      setBusy(undefined);
    }
  };

  const openCreate = () => {
    setForm(emptyForm);
    setFormError(undefined);
    setEditing({ mode: 'create' });
  };

  const openEdit = (t: Tenant) => {
    setForm(formFor(t));
    setFormError(undefined);
    setEditing({ mode: 'edit', tenant: t });
  };

  const submitForm = async () => {
    if (!editing) {
      return;
    }
    setSaving(true);
    setFormError(undefined);
    try {
      const domains = parseDomains(form.domains);
      if (editing.mode === 'create') {
        await service.createTenant({
          name: form.name,
          alias: form.alias.trim() || undefined,
          description: form.description || undefined,
          domains,
        });
      } else {
        const t = editing.tenant;
        await service.updateTenant(t.id, {
          ...(form.name !== t.name ? { name: form.name } : {}),
          ...(form.description !== t.description ? { description: form.description } : {}),
          ...(domains.join('\n') !== t.domains.join('\n') ? { domains } : {}),
        });
      }
      setEditing(undefined);
      await loadRef.current();
    } catch (e) {
      setFormError(e instanceof Error ? e : new Error(String(e)));
    } finally {
      setSaving(false);
    }
  };

  const confirmDelete = async () => {
    if (!deleting) {
      return;
    }
    const t = deleting;
    setDeleting(undefined);
    await runAction(t, 'deleted', () => service.deleteTenant(t.id));
  };

  const applySearch = (value: string) => {
    setSearch(value.trim());
    setOffset(0);
  };

  const total = page?.meta.total ?? 0;
  const items = page?.items ?? [];
  const pageNumber = Math.floor(offset / limit) + 1;

  return (
    <Stack hasGutter>
      <StackItem>
        <Title headingLevel="h2">Tenants</Title>
      </StackItem>
      <StackItem>
        <Toolbar inset={{ default: 'insetNone' }}>
          <ToolbarContent>
            <ToolbarItem>
              <SearchInput
                aria-label="Search tenants"
                placeholder="Search name or domain"
                style={{ minWidth: 280 }}
                value={searchDraft}
                onChange={(_e, value) => setSearchDraft(value)}
                onSearch={(_e, value) => applySearch(value)}
                onClear={() => {
                  setSearchDraft('');
                  applySearch('');
                }}
              />
            </ToolbarItem>
            {canEdit && (
              <ToolbarItem>
                <Button variant="primary" onClick={openCreate}>
                  Create tenant
                </Button>
              </ToolbarItem>
            )}
            <ToolbarItem align={{ default: 'alignEnd' }} variant="pagination">
              <Pagination
                itemCount={total}
                page={pageNumber}
                perPage={limit}
                perPageOptions={PER_PAGE_OPTIONS}
                onSetPage={(_e, newPage) => setOffset((newPage - 1) * limit)}
                onPerPageSelect={(_e, newPerPage) => {
                  setLimit(newPerPage);
                  setOffset(0);
                }}
                isCompact
                titles={{ paginationAriaLabel: 'Tenants pagination' }}
              />
            </ToolbarItem>
          </ToolbarContent>
        </Toolbar>
      </StackItem>
      {error && (
        <StackItem>
          <LoadError subject="Tenants" error={error} />
        </StackItem>
      )}
      {actionError && (
        <StackItem>
          <LoadError subject={`Tenant ${actionError.name}`} verb={actionError.verb} error={actionError.error} />
        </StackItem>
      )}
      <StackItem>
        {!page ? (
          <Spinner aria-label="Loading tenants" />
        ) : error ? null : items.length === 0 ? (
          <EmptyState titleText={search ? 'No tenants match' : 'No tenants'} headingLevel="h3">
            <EmptyStateBody>
              {search ? `No organisation name or domain contains "${search}".` : 'No organisations exist in the AI Grid identity realm yet.'}
            </EmptyStateBody>
          </EmptyState>
        ) : (
          <Table aria-label="Tenants" variant="compact">
            <Thead>
              <Tr>
                <Th>Name</Th>
                <Th>Alias</Th>
                <Th>Domains</Th>
                <Th modifier="fitContent">Enabled</Th>
                {canEdit && <Th modifier="fitContent" screenReaderText="Actions" />}
              </Tr>
            </Thead>
            <Tbody>
              {items.map((t) => (
                <Tr key={t.id}>
                  <Td dataLabel="Name">
                    <span data-testid={`tenant-${t.name}`}>{t.name}</span>
                    {t.description && (
                      <div>
                        <small>{t.description}</small>
                      </div>
                    )}
                  </Td>
                  <Td dataLabel="Alias">{t.alias}</Td>
                  <Td dataLabel="Domains">
                    {t.domainDetails.length
                      ? t.domainDetails.map((d) => (
                          <div key={d.name}>
                            {d.name}
                            {d.verified && (
                              <>
                                {' '}
                                <Label isCompact color="green">
                                  verified
                                </Label>
                              </>
                            )}
                          </div>
                        ))
                      : '-'}
                  </Td>
                  <Td dataLabel="Enabled" modifier="fitContent">
                    <Label color={t.enabled ? 'green' : 'grey'} data-testid={`enabled-${t.name}`}>
                      {t.enabled ? 'Enabled' : 'Disabled'}
                    </Label>
                  </Td>
                  {canEdit && (
                    <Td dataLabel="Actions" isActionCell>
                      <ActionsColumn
                        isDisabled={busy === t.id}
                        actionsToggle={({ onToggle, isOpen, isDisabled, toggleRef }) => (
                          <MenuToggle
                            ref={toggleRef}
                            aria-label={`Actions for ${t.name}`}
                            variant="plain"
                            icon={<EllipsisVIcon />}
                            isExpanded={isOpen}
                            isDisabled={isDisabled}
                            onClick={onToggle}
                          />
                        )}
                        items={[
                          { title: 'Edit', onClick: () => openEdit(t) },
                          {
                            title: t.enabled ? 'Disable' : 'Enable',
                            onClick: () => void runAction(t, 'updated', () => service.updateTenant(t.id, { enabled: !t.enabled })),
                          },
                          { isSeparator: true },
                          { title: 'Delete', onClick: () => setDeleting(t), isDanger: true },
                        ]}
                      />
                    </Td>
                  )}
                </Tr>
              ))}
            </Tbody>
          </Table>
        )}
      </StackItem>

      <Modal variant="small" isOpen={editing !== undefined} onClose={() => setEditing(undefined)} aria-labelledby="tenant-form-title">
        <ModalHeader title={editing?.mode === 'edit' ? `Edit tenant ${editing.tenant.name}` : 'Create tenant'} labelId="tenant-form-title" />
        <ModalBody>
          <Form
            id="tenant-form"
            onSubmit={(e) => {
              e.preventDefault();
              void submitForm();
            }}
          >
            {formError && (
              <Alert variant="danger" isInline title={editing?.mode === 'edit' ? 'Tenant could not be updated' : 'Tenant could not be created'}>
                {formError.message}
              </Alert>
            )}
            <FormGroup label="Name" isRequired fieldId="tenant-name">
              <TextInput id="tenant-name" isRequired value={form.name} onChange={(_e, value) => setForm({ ...form, name: value })} />
            </FormGroup>
            <FormGroup label="Alias" fieldId="tenant-alias">
              <TextInput
                id="tenant-alias"
                value={form.alias}
                isDisabled={editing?.mode === 'edit'}
                placeholder={editing?.mode === 'create' ? 'Defaults to the name' : undefined}
                onChange={(_e, value) => setForm({ ...form, alias: value })}
              />
              <FormHelperText>
                <HelperText>
                  <HelperTextItem>
                    {editing?.mode === 'edit' ? 'The alias cannot be changed.' : 'URL-safe handle; no spaces or reserved characters.'}
                  </HelperTextItem>
                </HelperText>
              </FormHelperText>
            </FormGroup>
            <FormGroup label="Description" fieldId="tenant-description">
              <TextInput id="tenant-description" value={form.description} onChange={(_e, value) => setForm({ ...form, description: value })} />
            </FormGroup>
            <FormGroup label="Domains" fieldId="tenant-domains">
              <TextArea
                id="tenant-domains"
                value={form.domains}
                rows={3}
                resizeOrientation="vertical"
                onChange={(_e, value) => setForm({ ...form, domains: value })}
              />
              <FormHelperText>
                <HelperText>
                  <HelperTextItem>One per line or comma-separated, e.g. acme.example.com or *.acme.example.org.</HelperTextItem>
                </HelperText>
              </FormHelperText>
            </FormGroup>
            {editing?.mode === 'edit' && (
              <Checkbox id="tenant-enabled" label="Enabled" isChecked={editing.tenant.enabled} isDisabled description="Use the row actions to enable or disable." />
            )}
          </Form>
        </ModalBody>
        <ModalFooter>
          <Button variant="primary" type="submit" form="tenant-form" isLoading={saving} isDisabled={saving || !form.name.trim()}>
            {editing?.mode === 'edit' ? 'Save' : 'Create'}
          </Button>
          <Button variant="link" onClick={() => setEditing(undefined)} isDisabled={saving}>
            Cancel
          </Button>
        </ModalFooter>
      </Modal>

      <Modal variant="small" isOpen={deleting !== undefined} onClose={() => setDeleting(undefined)} aria-labelledby="tenant-delete-title">
        <ModalHeader title={`Delete tenant ${deleting?.name ?? ''}?`} labelId="tenant-delete-title" titleIconVariant="warning" />
        <ModalBody>
          The organisation, its memberships and its invitations are removed from the AI Grid identity realm. Members managed through one of the
          organisation&apos;s identity providers have their user accounts deleted from the realm; members who were added as existing realm users keep
          their accounts.
        </ModalBody>
        <ModalFooter>
          <Button variant="danger" onClick={() => void confirmDelete()}>
            Delete
          </Button>
          <Button variant="link" onClick={() => setDeleting(undefined)}>
            Cancel
          </Button>
        </ModalFooter>
      </Modal>
    </Stack>
  );
};
