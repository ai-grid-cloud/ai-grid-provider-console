import { useState } from 'react';
import { useNavigate } from 'react-router-dom';
import { Code } from '@connectrpc/connect';
import { describeError } from '../../api/connect/errors';
import { useNotifications } from '../../notifications/useNotifications';
import { organizationSavedText } from '../../notifications/writeText';
import {
  fieldErrorsOf,
  identityProviderSchema,
  isBlankIdentityProvider,
  organizationInputSchema,
  tenantDetailsSchema,
} from '../../validation';
import { formPathOf, type OrganizationInput, type OrganizationView } from './organizationView';
import {
  ORGANIZATION_CHANGED,
  ORGANIZATION_ISSUER_MAYBE_SAVED,
  ORGANIZATION_MAYBE_SAVED,
  currentServerErrors,
  emptyOrganizationInput,
  errorsUnder,
} from './serverErrors';
import { useOrganizationWrites } from './useOrganizations';

/**
 * What a refused save says: the backend's message, the console's words where describeError gives
 * them, and on an edit, for a stale version (Aborted), that someone else changed the organization.
 * An edit answered Unavailable or DeadlineExceeded may have been saved (the backend's Update answers
 * Unavailable when it can't read the organization back after an error), so it says to check before
 * trying again: a retry after a save that landed is refused as stale. When the edit sent a new
 * issuer, it also says that logins may already use it.
 */
const saveErrorMessage = (err: unknown, editing: boolean, issuerChanged: boolean) => {
  const { kind, code, message } = describeError(err);
  if (kind === 'notAvailable') {
    return 'Saving organizations is not available on this AI Grid backend.';
  }
  if (editing && kind === 'conflict') {
    return ORGANIZATION_CHANGED;
  }
  if (editing && (code === Code.Unavailable || code === Code.DeadlineExceeded)) {
    return issuerChanged ? `${ORGANIZATION_MAYBE_SAVED} ${ORGANIZATION_ISSUER_MAYBE_SAVED}` : ORGANIZATION_MAYBE_SAVED;
  }
  return message;
};

/** The backend's field violations, keyed by the form's paths. */
const serverFieldErrors = (err: unknown): Record<string, string> | undefined => {
  const { fieldErrors } = describeError(err);
  return fieldErrors && Object.fromEntries(Object.entries(fieldErrors).map(([field, msg]) => [formPathOf(field), msg]));
};

/** The form always holds an identity provider; a blank one is left out on save. */
type FormValues = Required<OrganizationInput>;

const initialValues = (initial?: OrganizationView): FormValues =>
  initial
    ? {
        name: initial.name,
        domains: initial.domains,
        // Without one, a blank provider, which the edit can fill in to add one.
        identityProvider: initial.identityProvider ?? emptyOrganizationInput().identityProvider,
      }
    : emptyOrganizationInput();

/**
 * The organization form's state, validation and save, shared by the create wizard and the edit
 * form: the values, the client-side errors by JSON path, the server's field errors that still
 * apply, and whether anything changed since the form opened.
 */
export const useOrganizationForm = (initial?: OrganizationView) => {
  const navigate = useNavigate();
  const writes = useOrganizationWrites();
  const { notify } = useNotifications();
  const [start] = useState(() => initialValues(initial));
  const [values, setValues] = useState<FormValues>(start);
  const [saving, setSaving] = useState(false);
  const [error, setError] = useState<string>();
  // The server's field errors and the form values they were returned for.
  const [server, setServer] = useState<{ errors: Record<string, string>; sent: OrganizationInput }>();

  const detailErrors = fieldErrorsOf(tenantDetailsSchema, { name: values.name, domains: values.domains });
  const detailsValid = Object.keys(detailErrors).length === 0;
  const storedIdp = initial?.identityProvider;
  // Optional while the organization has none: a blank form is valid, and is left out on save.
  const idpBlank = !storedIdp && isBlankIdentityProvider(values.identityProvider);
  // What the save sends: on create, the identity provider filled in; on edit, one added or changed.
  // The backend can't remove one, and an unchanged one stays as stored, even one saved before a
  // rule the form checks (a JWKS URL while Validate signature is on).
  const idpToSend =
    idpBlank || (initial && JSON.stringify(values.identityProvider) === JSON.stringify(start.identityProvider))
      ? undefined
      : values.identityProvider;
  const idpValid = !idpToSend || identityProviderSchema.safeParse(idpToSend).success;
  // An edit sends the domains only when they changed, so an edit of the identity provider alone
  // leaves them as stored.
  const domainsChanged = JSON.stringify(values.domains) !== JSON.stringify(start.domains);
  // What Review shows: the values without a blank identity provider.
  const toSave: OrganizationInput = idpBlank ? { ...values, identityProvider: undefined } : values;
  const serverErrors = server ? currentServerErrors(server.errors, server.sent, values) : {};

  const leave = () => navigate(initial ? `/organizations/${encodeURIComponent(initial.id)}` : '/organizations');

  const save = async () => {
    const input = organizationInputSchema.safeParse({ ...values, identityProvider: idpToSend });
    if (saving || !input.success) return;
    setSaving(true);
    setError(undefined);
    setServer(undefined);
    try {
      // An edit sends the domains when they changed, and the identity provider when it adds or
      // changes one, at the version the form read.
      const saved = initial
        ? await writes.updateOrganization(initial, {
            domains: domainsChanged ? input.data.domains : undefined,
            identityProvider: input.data.identityProvider,
          })
        : await writes.createOrganization(input.data);
      // The save is complete when the backend answers (a Keycloak write, or its rollback), so the
      // notification center says it once, by the name the backend answered with, in answer to the
      // user's click. A refusal stays on the form.
      notify({ variant: 'success', ...organizationSavedText(initial ? 'update' : 'create', saved), read: true });
      // A created organization replaces its create form in history, so Back doesn't land on it, empty.
      navigate(initial ? `/organizations/${encodeURIComponent(initial.id)}` : '/organizations', {
        replace: !initial,
      });
    } catch (err) {
      // Only an edit that sent another issuer than the stored one: adding a provider changes none.
      const issuerChanged = !!storedIdp && !!idpToSend && idpToSend.config.issuer !== storedIdp.config.issuer;
      setError(saveErrorMessage(err, !!initial, issuerChanged));
      const fieldErrors = serverFieldErrors(err);
      if (fieldErrors) {
        setServer({ errors: fieldErrors, sent: values });
      }
      setSaving(false);
    }
  };

  return {
    values,
    setValues,
    saving,
    error,
    detailErrors,
    detailsValid,
    idpValid,
    /** Editing an organization that has an identity provider: its stored issuer. */
    savedIssuer: storedIdp?.config.issuer,
    /** What a save sends, which the Review step shows: the values without a blank identity provider. */
    toSave,
    /** The server's errors for name and domains, keyed like detailErrors. */
    detailServerErrors: Object.fromEntries(
      Object.entries(serverErrors).filter(([path]) => !path.startsWith('identityProvider.')),
    ),
    /** The server's errors under identityProvider, keyed by the rest of the path. */
    idpServerErrors: errorsUnder(serverErrors, 'identityProvider'),
    /**
     * Whether the form holds anything to lose: on create, anything typed; on edit, what a save would
     * send (changed domains, or a provider added or changed), so leaving warns exactly when Save
     * changes is enabled.
     */
    isDirty: initial ? domainsChanged || !!idpToSend : JSON.stringify(values) !== JSON.stringify(start),
    /** The last refused save's field errors, a new object each time, for moving to them. */
    serverErrorsSent: server,
    save,
    leave,
  };
};
