import { z } from 'zod';

/**
 * Field errors keyed by JSON path, the last message per path, as the PoC keeps them
 * (Object.fromEntries over the zod issues) and as bff/internal/validation does.
 */
export const fieldErrorsOf = (schema: z.ZodTypeAny, input: unknown): Record<string, string> => {
  const result = schema.safeParse(input);
  if (result.success) return {};
  const out: Record<string, string> = {};
  for (const issue of result.error.issues) {
    out[issue.path.join('.')] = issue.message;
  }
  return out;
};

// Ported from krisv/ai-grid-cloud-provider-poc shared/tenant-validation.mjs at 62319b8.
// Adapted from OSAC tenant validation and IdentityProvider/CreateWizard validation.
const domainLabel = /^[a-z0-9]([a-z0-9-]{0,61}[a-z0-9])?$/;
export const tenantNameSchema = z
  .string()
  .trim()
  .min(1)
  .max(63)
  .regex(/^[a-z0-9]([-a-z0-9]*[a-z0-9])?$/, 'Use lowercase letters, numbers, and hyphens.');
export const tenantDetailsSchema = z
  .object({
    name: tenantNameSchema,
    domains: z
      .array(
        z
          .string()
          .trim()
          .toLowerCase()
          .max(253)
          .refine(
            (value) => value.split('.').length >= 2 && value.split('.').every((label) => domainLabel.test(label)),
            'Enter a valid domain, for example example.com.',
          ),
      )
      .max(64)
      .refine((domains) => new Set(domains).size === domains.length, 'Domains must be unique.'),
  })
  .strict();
const url = z
  .string()
  .trim()
  .max(2048)
  .url('Enter a valid HTTP or HTTPS URL.')
  .refine((value) => /^https?:\/\//.test(value), 'Use HTTP or HTTPS.');
const optionalUrl = z.union([z.literal(''), url]).default('');
export const oidcConfigSchema = z
  .object({
    clientId: z.string().trim().min(1, 'Client ID is required.').max(253),
    clientSecretSecret: z
      .object({
        name: z
          .string()
          .trim()
          .min(1, 'Client secret reference is required.')
          .max(253)
          .regex(/^[a-z0-9]([-a-z0-9.]*[a-z0-9])?$/, 'Enter a valid secret reference name.'),
      })
      .strict(),
    issuer: url,
    authorizationUrl: url,
    tokenUrl: url,
    defaultScopes: z.string().trim().max(2048).default(''),
    userInfoUrl: optionalUrl,
    jwksUrl: optionalUrl,
    logoutUrl: optionalUrl,
    validateSignature: z.boolean().default(true),
  })
  .strict();
export const identityProviderSchema = z
  .object({
    title: z.string().trim().max(253).default(''),
    description: z.string().max(4000).default(''),
    enabled: z.literal(true).default(true),
    config: oidcConfigSchema,
  })
  .strict();
export const organizationInputSchema = tenantDetailsSchema
  .extend({ identityProvider: identityProviderSchema })
  .strict();

/** One validator per schema name in mock/validation/cases.json. */
export const validators = {
  organization: (input: unknown) => fieldErrorsOf(organizationInputSchema, input),
};
