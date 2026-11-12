import type { OrganizationInput } from './organizationView';

/** The PoC's message for a stale version (Aborted): the organization changed since the page read it. */
export const ORGANIZATION_CHANGED = 'This organization was changed by another user. Reload the page, then try again.';

/** An edit whose outcome the backend couldn't confirm (Unavailable, DeadlineExceeded): it may have been saved. */
export const ORGANIZATION_MAYBE_SAVED =
  'The AI Grid backend could not confirm the save, so the changes may have been saved. Reload the page to check, then try again if they are missing.';

/**
 * Added to ORGANIZATION_MAYBE_SAVED when the edit sent a new issuer: if it landed, Keycloak already
 * uses it, so a login test before the reload would test the new issuer while the page shows the old
 * one. The backend's Unavailable message says so too, but embeds raw errors, so the form never
 * shows it (describeError).
 */
export const ORGANIZATION_ISSUER_MAYBE_SAVED =
  'If the new issuer was saved, users already log in through it, so test logging in only after the reloaded page shows the new issuer.';

/** The value at a JSON path such as `identityProvider.config.issuer` or `domains.0`. */
const valueAt = (value: unknown, path: string): unknown =>
  path
    .split('.')
    .reduce<unknown>((v, key) => (v && typeof v === 'object' ? (v as Record<string, unknown>)[key] : undefined), value);

/**
 * The server's field errors that still apply: those whose field the user hasn't
 * changed since the save that returned them.
 */
export const currentServerErrors = (
  errors: Record<string, string>,
  sent: OrganizationInput,
  values: OrganizationInput,
): Record<string, string> =>
  Object.fromEntries(
    Object.entries(errors).filter(
      ([path]) => JSON.stringify(valueAt(values, path)) === JSON.stringify(valueAt(sent, path)),
    ),
  );

/** The errors under `prefix.`, keyed by the rest of the path. */
export const errorsUnder = (errors: Record<string, string>, prefix: string): Record<string, string> =>
  Object.fromEntries(
    Object.entries(errors)
      .filter(([path]) => path.startsWith(`${prefix}.`))
      .map(([path, message]) => [path.slice(prefix.length + 1), message]),
  );

/** A new organization: no domains and an empty OIDC identity provider. */
export const emptyOrganizationInput = (): Required<OrganizationInput> => ({
  name: '',
  domains: [],
  identityProvider: {
    title: '',
    description: '',
    enabled: true,
    config: {
      clientId: '',
      clientSecretSecret: { name: '' },
      issuer: '',
      authorizationUrl: '',
      tokenUrl: '',
      defaultScopes: '',
      userInfoUrl: '',
      jwksUrl: '',
      logoutUrl: '',
      validateSignature: true,
    },
  },
});
