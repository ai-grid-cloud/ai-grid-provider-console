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

/**
 * The schema's message for a text field that has input but fails, so a disabled Next comes with a
 * reason. An empty field shows nothing, so a step never opens with errors. A number field passes
 * `Number` as `parse`.
 */
export const fieldMessage = (
  schema: z.ZodTypeAny,
  value: string,
  parse: (text: string) => unknown = (text) => text,
): string | undefined => {
  const result = value.trim() ? schema.safeParse(parse(value)) : undefined;
  return result && !result.success ? result.error.issues[0]?.message : undefined;
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
  .extend({ identityProvider: identityProviderSchema.optional() })
  .strict();
/** An identity provider form with nothing typed in it, which the organization form leaves out. */
export const isBlankIdentityProvider = ({ title, description, config }: z.input<typeof identityProviderSchema>) =>
  ![
    title,
    description,
    config.clientId,
    config.clientSecretSecret.name,
    config.issuer,
    config.authorizationUrl,
    config.tokenUrl,
    config.defaultScopes,
    config.userInfoUrl,
    config.jwksUrl,
    config.logoutUrl,
  ].some((v) => v?.trim());

// Ported from krisv/ai-grid-cloud-provider-poc shared/subscription-validation.mjs at 62319b8.
export const resourceName = z
  .string()
  .min(1)
  .max(253)
  .regex(/^[a-z0-9]([-a-z0-9]*[a-z0-9])?$/);
export const dnsName = z
  .string()
  .min(1)
  .max(253)
  .regex(/^[a-z0-9]([-a-z0-9]*[a-z0-9])?(\.[a-z0-9]([-a-z0-9]*[a-z0-9])?)*$/);
const group = z.object({ name: z.string().trim().min(1) }).passthrough();
const guardrails = z
  .array(
    z
      .object({
        ref: z.object({ name: dnsName }).strict(),
        checks: z.array(z.string().min(1).max(63)).max(64).optional(),
      })
      .passthrough(),
  )
  .max(64);
// The MaaSSubscription CRD's token rate limit rules and messages, the same as the backend's
// (bff/internal/validation/subscription.go): the CEL texts are the CRD's; the window pattern
// and limit range are worded as the API server's schema validator words them (unverified
// against a hub).
const MSG_TOKEN_RATE_LIMITS_REQUIRED = 'tokenRateLimits is required unless unlimited is true';
const MSG_TOKEN_RATE_LIMITS_UNLIMITED = 'tokenRateLimits must not be set when unlimited is true';
const RATE_WINDOW = /^[1-9]\d{0,3}(s|m|h)$/;
const rate = z
  .object({
    limit: z
      .number()
      .int()
      .min(1, 'should be greater than or equal to 1')
      .max(1_000_000_000, 'should be less than or equal to 1000000000'),
    window: z.string().regex(RATE_WINDOW, `should match '${RATE_WINDOW.source}'`),
  })
  .passthrough();
const metadata = z
  .object({
    organizationId: z.string().optional(),
    costCenter: z.string().optional(),
    labels: z.record(z.string()).optional(),
  })
  .passthrough();
export const inputModelSchema = z
  .object({
    name: dnsName.max(63),
    /** P6: the model's namespace; the backend checks it as a namespace name. */
    namespace: z.string().optional(),
    displayName: z.string().optional(),
    description: z.string().optional(),
    unlimited: z.boolean().optional(),
    tokenRateLimits: z.array(rate),
    billingRate: z.object({ perToken: z.string() }).passthrough().optional(),
    guardrails: guardrails.optional(),
  })
  .passthrough()
  .superRefine((ref, ctx) => {
    if (!ref.unlimited && ref.tokenRateLimits.length === 0) {
      ctx.addIssue({ code: z.ZodIssueCode.custom, message: MSG_TOKEN_RATE_LIMITS_REQUIRED });
    }
    if (ref.unlimited && ref.tokenRateLimits.length > 0) {
      ctx.addIssue({ code: z.ZodIssueCode.custom, message: MSG_TOKEN_RATE_LIMITS_UNLIMITED });
    }
  });
/** The body of PUT /api/v1/subscriptions/{name}: the PoC's updateSchema. */
export const updateSubscriptionSchema = z
  .object({
    namespace: z.never().optional(),
    displayName: z.string().trim().min(1).optional(),
    description: z.string().optional(),
    priority: z.number().int().min(-1_000_000).max(1_000_000),
    owner: z.object({ groups: z.array(group).min(1), users: z.array(z.string().min(1)).optional() }).passthrough(),
    modelRefs: z
      .array(inputModelSchema)
      .min(1)
      .refine((refs) => new Set(refs.map((ref) => ref.name)).size === refs.length, 'Models must be unique'),
    tokenMetadata: metadata.optional(),
    inferencePriority: z.number().int().min(-2147483648).max(2147483647).optional(),
    guardrails: guardrails.optional(),
  })
  .passthrough();
/**
 * The body of POST /api/v1/subscriptions: the PoC's createSchema, plus the console's
 * organization, which a new subscription needs (tokenMetadata.organizationId).
 */
export const createSubscriptionSchema = updateSubscriptionSchema.extend({
  name: resourceName,
  createAuthPolicy: z.boolean(),
  tokenMetadata: z.preprocess(
    (value) => (value === undefined ? {} : value),
    metadata.extend({
      organizationId: z.string({ required_error: 'Select an organization' }).min(1, 'Select an organization'),
    }),
  ),
});

// Ported from krisv/ai-grid-cloud-provider-poc shared/model-validation.mjs at 62319b8.
export const modelNameSchema = resourceName.max(63);
export const locationSchema = z
  .string()
  .min(1)
  .max(63)
  .regex(/^[A-Za-z0-9](?:[A-Za-z0-9_.-]*[A-Za-z0-9])?$/, 'Use a Kubernetes label value for the location.');
export const locationsSchema = z
  .array(locationSchema)
  .max(64)
  .refine((values) => new Set(values).size === values.length, 'Locations must be unique.');
export const createModelSchema = z
  .object({
    name: modelNameSchema,
    displayName: z.string().trim().min(1).max(253),
    description: z.string().max(4000).optional(),
    modelUri: z
      .string()
      .trim()
      .max(2048)
      .regex(/^(hf|oci|s3|pvc):\/\/[^\s]+$/, 'Enter a model URI using hf, oci, s3 or pvc.'),
    modelName: z.string().trim().min(1).max(253),
    runtimeImage: z.string().trim().min(1).max(2048).regex(/^\S+$/, 'Enter a container image without spaces.'),
    replicas: z.number().int().min(1).max(99),
    cpu: z
      .string()
      .regex(
        /^(?:[1-9]\d*|0\.[0-9]*[1-9]\d*|[1-9]\d*\.\d+|[1-9]\d*m)$/,
        'Enter positive CPU cores or millicores, for example 2 or 500m.',
      ),
    memory: z.string().regex(/^[1-9]\d*(?:Mi|Gi|Ti)$/, 'Enter memory such as 4Gi or 512Mi.'),
    gpuCount: z.number().int().min(0).max(64),
    runtimeArgs: z.array(z.string().max(4096)).max(64),
    baseRefs: z.array(z.string().min(1, 'Enter a preset name.').max(253)).max(8),
    // Optional: the shared validation cases (mock/validation/cases.json) predate it.
    api: z.enum(['chat', 'completions']).optional(),
    locations: locationsSchema.refine((values) => values.length > 0, 'Select at least one location.'),
  })
  .strict();

/** One validator per schema name in mock/validation/cases.json. */
export const validators = {
  organization: (input: unknown) => fieldErrorsOf(organizationInputSchema, input),
  model: (input: unknown) => fieldErrorsOf(createModelSchema, input),
  createSubscription: (input: unknown) => fieldErrorsOf(createSubscriptionSchema, input),
  updateSubscription: (input: unknown) => fieldErrorsOf(updateSubscriptionSchema, input),
};
