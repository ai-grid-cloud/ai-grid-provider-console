import type { OrganizationInput } from '../../api/types';

/** The PoC's message for a 409: the organization changed since the page read it. */
export const ORGANIZATION_CHANGED = 'This organization changed. Reload it before saving or deleting.';

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
export const emptyOrganizationInput = (): OrganizationInput => ({
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
