// The Organizations pages' reading of the backend's Tenant (ai_grid.v1, docs/connect.md, "The
// Organizations area"), and the form's values: the thin selector layer ADR-0002 allows. The
// backend decides what a tenant is; the pages word it.
import type { MessageInitShape } from '@bufbuild/protobuf';
import { timestampDate } from '@bufbuild/protobuf/wkt';
import type { IdentityProviderSchema, Tenant, TenantSchema } from '../../gen/ai_grid/v1/tenant_type_pb';

/** The OIDC client configuration as the form holds it (the PoC's shape, which the validation keeps). */
export type OidcConfig = {
  clientId: string;
  /** Only the name of the Secret holding the client secret; never the secret itself. */
  clientSecretSecret: { name: string };
  issuer: string;
  authorizationUrl: string;
  tokenUrl: string;
  defaultScopes: string;
  userInfoUrl: string;
  jwksUrl: string;
  logoutUrl: string;
  validateSignature: boolean;
};

export type IdentityProvider = { title: string; description: string; enabled: true; config: OidcConfig };

/**
 * What the pages say for a Tenant without spec.identity_provider. The backend projects only the
 * identity provider it created (its own organization attribute), so an organization whose provider
 * was set up in Keycloak directly arrives without one too: the words state what AI grid knows, and
 * the consequence only unless Keycloak has one.
 */
export const NO_IDENTITY_PROVIDER = 'No identity provider configured in AI grid';
export const NO_IDENTITY_PROVIDER_REASON =
  "Unless an identity provider was set up directly in Keycloak, this organization's users cannot log in.";

/** The form's values. `identityProvider` is optional: an organization can be created without one. */
export type OrganizationInput = { name: string; domains: string[]; identityProvider?: IdentityProvider };

/**
 * An organization as the pages show it. `identityProvider` is absent for one created without
 * an identity provider.
 */
export type OrganizationView = Omit<OrganizationInput, 'identityProvider'> & {
  id: string;
  identityProvider?: IdentityProvider;
  /** metadata.version, which an update and a delete send back; a stale one is Aborted. */
  version: number;
  /** When the backend created it (RFC 3339); absent for one created outside the backend. */
  creationTimestamp?: string;
};

const toIdentityProvider = (idp: NonNullable<NonNullable<Tenant['spec']>['identityProvider']>): IdentityProvider => {
  const c = idp.config;
  return {
    title: idp.title,
    description: idp.description,
    // The backend refuses a disabled identity provider.
    enabled: true,
    config: {
      clientId: c?.clientId ?? '',
      clientSecretSecret: { name: c?.clientSecretSecretName ?? '' },
      issuer: c?.issuer ?? '',
      authorizationUrl: c?.authorizationUrl ?? '',
      tokenUrl: c?.tokenUrl ?? '',
      defaultScopes: c?.defaultScopes ?? '',
      userInfoUrl: c?.userInfoUrl ?? '',
      jwksUrl: c?.jwksUrl ?? '',
      logoutUrl: c?.logoutUrl ?? '',
      // Unset means true (OidcConfig.validate_signature).
      validateSignature: c?.validateSignature ?? true,
    },
  };
};

/** A Tenant as the pages show it: its name (metadata.name, else its id), domains and identity provider. */
export const toOrganizationView = (tenant: Tenant): OrganizationView => {
  const created = tenant.metadata?.creationTimestamp;
  const idp = tenant.spec?.identityProvider;
  return {
    id: tenant.id,
    name: tenant.metadata?.name || tenant.id,
    domains: [...(tenant.spec?.domains ?? [])],
    version: tenant.metadata?.version ?? 0,
    ...(created ? { creationTimestamp: timestampDate(created).toISOString() } : {}),
    ...(idp ? { identityProvider: toIdentityProvider(idp) } : {}),
  };
};

/** The form's identity provider as the backend's message. */
const identityProviderOf = ({
  title,
  description,
  enabled,
  config,
}: IdentityProvider): MessageInitShape<typeof IdentityProviderSchema> => ({
  title,
  description,
  enabled,
  config: {
    clientId: config.clientId,
    clientSecretSecretName: config.clientSecretSecret.name,
    issuer: config.issuer,
    authorizationUrl: config.authorizationUrl,
    tokenUrl: config.tokenUrl,
    defaultScopes: config.defaultScopes,
    userInfoUrl: config.userInfoUrl,
    jwksUrl: config.jwksUrl,
    logoutUrl: config.logoutUrl,
    validateSignature: config.validateSignature,
  },
});

/** A Tenant's spec: the domains and the identity provider, each when there is one to send. */
export const tenantSpecOf = ({
  domains,
  identityProvider,
}: Partial<Omit<OrganizationInput, 'name'>>): NonNullable<MessageInitShape<typeof TenantSchema>['spec']> => ({
  ...(domains ? { domains } : {}),
  ...(identityProvider ? { identityProvider: identityProviderOf(identityProvider) } : {}),
});

/** What Tenants/Create sends: the name, the domains and the identity provider, when the form has one. */
export const tenantOf = (input: OrganizationInput): MessageInitShape<typeof TenantSchema> => ({
  metadata: { name: input.name },
  spec: tenantSpecOf(input),
});

/**
 * The form's path of each OIDC config field the backend's Tenant names differently, by its proto
 * name or its JSON name, for a field violation (google.rpc.BadRequest).
 */
const formFields: Record<string, string> = {
  client_id: 'clientId',
  client_secret_secret_name: 'clientSecretSecret.name',
  clientSecretSecretName: 'clientSecretSecret.name',
  authorization_url: 'authorizationUrl',
  token_url: 'tokenUrl',
  default_scopes: 'defaultScopes',
  user_info_url: 'userInfoUrl',
  jwks_url: 'jwksUrl',
  logout_url: 'logoutUrl',
  validate_signature: 'validateSignature',
};

/**
 * The form's path (`name`, `domains.0`, `identityProvider.config.issuer`) of a field the backend
 * names in a field violation (`metadata.name`, `spec.domains[0]`,
 * `spec.identity_provider.config.issuer`), or the path itself when it is none of the Tenant's.
 */
export const formPathOf = (field: string): string => {
  const path = field.replace(/^object\./, '').replace(/\[(\d+)\]/g, '.$1');
  if (path === 'metadata.name') return 'name';
  if (path === 'spec.domains' || path.startsWith('spec.domains.')) return path.slice('spec.'.length);
  const idp = /^spec\.(?:identity_provider|identityProvider)(?:\.(.*))?$/.exec(path);
  if (!idp) return path;
  if (!idp[1]) return 'identityProvider';
  const [head, ...rest] = idp[1].split('.');
  if (head !== 'config' || rest.length === 0) return `identityProvider.${idp[1]}`;
  return `identityProvider.config.${formFields[rest.join('.')] ?? rest.join('.')}`;
};
