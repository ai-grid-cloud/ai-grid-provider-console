// Ported from krisv/ai-grid-cloud-provider-poc src/app/pages/tenants/IdentityProviderFields.tsx at 62319b8.
// Adapted from OSAC IdpGeneralStep.tsx and IdpConfigurationStep.tsx at 8cb0a227e45cc9b17421b6e79ce493ed370ebd5d.
import { useState } from 'react';
import {
  Alert,
  Checkbox,
  FormGroup,
  FormHelperText,
  FormSection,
  HelperText,
  HelperTextItem,
  TextArea,
  TextInput,
} from '@patternfly/react-core';
import type { IdentityProvider, OidcConfig } from './organizationView';
import { fieldErrorsOf, identityProviderSchema } from '../../validation';

type TextKey = Exclude<keyof OidcConfig, 'clientSecretSecret' | 'validateSignature'>;

type Field = { key: TextKey; label: string; required?: boolean; help?: React.ReactNode };

const connectionFields: Field[] = [
  { key: 'clientId', label: 'Client ID', required: true },
  { key: 'issuer', label: 'Issuer', required: true, help: 'For example https://sso.example.com/realms/acme.' },
];

const endpointFields: Field[] = [
  { key: 'authorizationUrl', label: 'Authorization URL', required: true },
  { key: 'tokenUrl', label: 'Token URL', required: true },
  { key: 'userInfoUrl', label: 'User info URL' },
  {
    key: 'jwksUrl',
    label: 'JSON Web Key Set (JWKS) URL',
    help: (
      <>
        This field is required when <strong>Validate signature</strong> is on.
      </>
    ),
  },
  { key: 'logoutUrl', label: 'Logout URL' },
];

const SECRET_PATH = 'config.clientSecretSecret.name';

/**
 * The issuer's help once the organization has an identity provider. Keycloak links a user who
 * logged in to the provider by the user ID it sends, not by its issuer, so the backend refuses a
 * new issuer once any user has logged in (FailedPrecondition); a wrong issuer lets nobody log in,
 * so it can still be corrected. After that, the ways out are those the backend's refusal names:
 * remove the users' links to the provider in Keycloak, which keeps the organization, or create a
 * new one.
 */
const SAVED_ISSUER_HELP =
  "The issuer can be edited only until a user logs in through this identity provider. After that, to use a different issuer, remove the users' links to this identity provider in Keycloak, or create a new organization.";

type Props = {
  value: IdentityProvider;
  onChange: (provider: IdentityProvider) => void;
  /** The server's messages, keyed by path under identityProvider; shown whether or not the field was touched. */
  serverErrors?: Record<string, string>;
  /**
   * Editing an organization that has an identity provider: its stored issuer. The issuer's help
   * says when it can change, and a warning stays under it while the form holds another one.
   */
  savedIssuer?: string;
  /** While the form saves, so nothing changes under the request. */
  isDisabled?: boolean;
};

/** A field's error, or its help when it has none (PatternFly: the error replaces the help). */
const Help: React.FC<{ error?: string; children?: React.ReactNode }> = ({ error, children }) =>
  error || children ? (
    <FormHelperText>
      <HelperText>
        <HelperTextItem variant={error ? 'error' : 'default'}>{error ?? children}</HelperTextItem>
      </HelperText>
    </FormHelperText>
  ) : null;

/**
 * An organization's OIDC identity provider: who it is, how the console connects (client and
 * issuer), and the provider's endpoints. Renders form fields only; the caller supplies the Form.
 */
export const IdentityProviderFields: React.FC<Props> = ({
  value,
  onChange,
  serverErrors = {},
  savedIssuer,
  isDisabled,
}) => {
  const [touched, setTouched] = useState<Set<string>>(() => new Set());
  const errors = fieldErrorsOf(identityProviderSchema, value);
  const error = (path: string): string | undefined =>
    serverErrors[path] ?? (touched.has(path) ? errors[path] : undefined);
  const touch = (path: string) => setTouched((previous) => new Set([...previous, path]));
  const setConfig = (config: Partial<OidcConfig>) => onChange({ ...value, config: { ...value.config, ...config } });

  const textField = (field: Field) => {
    const path = `config.${field.key}`;
    // Keycloak validates signatures with the keys at the JWKS URL.
    const required = field.required || (field.key === 'jwksUrl' && value.config.validateSignature);
    return (
      <FormGroup key={field.key} label={field.label} fieldId={`idp-${field.key}`} isRequired={required}>
        <TextInput
          id={`idp-${field.key}`}
          value={value.config[field.key]}
          isRequired={required}
          isDisabled={isDisabled}
          validated={error(path) ? 'error' : 'default'}
          onBlur={() => touch(path)}
          onChange={(_event, text) => setConfig({ [field.key]: text })}
        />
        <Help error={error(path)}>
          {field.key === 'issuer' && savedIssuer !== undefined ? SAVED_ISSUER_HELP : field.help}
        </Help>
      </FormGroup>
    );
  };

  return (
    <>
      <FormGroup label="Identity provider name" fieldId="idp-title">
        <TextInput
          id="idp-title"
          value={value.title}
          isDisabled={isDisabled}
          onChange={(_event, title) => onChange({ ...value, title })}
        />
        <Help>The name users see on the login page.</Help>
      </FormGroup>
      <FormGroup label="Description" fieldId="idp-description">
        <TextArea
          id="idp-description"
          value={value.description}
          isDisabled={isDisabled}
          onChange={(_event, description) => onChange({ ...value, description })}
        />
      </FormGroup>
      <FormSection title="Connection" titleElement="h2">
        {textField(connectionFields[0])}
        <FormGroup label="Client secret reference" fieldId="idp-secret-reference" isRequired>
          <TextInput
            id="idp-secret-reference"
            value={value.config.clientSecretSecret.name}
            isRequired
            isDisabled={isDisabled}
            validated={error(SECRET_PATH) ? 'error' : 'default'}
            onBlur={() => touch(SECRET_PATH)}
            onChange={(_event, name) => setConfig({ clientSecretSecret: { name } })}
          />
          <Help error={error(SECRET_PATH)}>
            The name of the Secret that holds the OpenID Connect (OIDC) client secret.
          </Help>
        </FormGroup>
        {textField(connectionFields[1])}
        {savedIssuer !== undefined && value.config.issuer.trim() !== savedIssuer && (
          <Alert
            variant="warning"
            isInline
            isPlain
            title="A new issuer is saved only if no user has logged in through this identity provider"
          />
        )}
        <FormGroup label="Default scopes" fieldId="idp-defaultScopes">
          <TextInput
            id="idp-defaultScopes"
            value={value.config.defaultScopes}
            isDisabled={isDisabled}
            validated={error('config.defaultScopes') ? 'error' : 'default'}
            onBlur={() => touch('config.defaultScopes')}
            onChange={(_event, defaultScopes) => setConfig({ defaultScopes })}
          />
          <Help error={error('config.defaultScopes')}>Separate scopes using spaces.</Help>
        </FormGroup>
        <Checkbox
          id="idp-validate-signature"
          label="Validate signature"
          description="Verify token signatures with the provider's JSON Web Key Set (JWKS) keys."
          isChecked={value.config.validateSignature}
          isDisabled={isDisabled}
          onChange={(_event, validateSignature) => setConfig({ validateSignature })}
        />
      </FormSection>
      <FormSection title="OIDC endpoints" titleElement="h2">
        <HelperText>
          <HelperTextItem>
            Find these in the provider&apos;s OpenID configuration, at the issuer URL followed by
            /.well-known/openid-configuration.
          </HelperTextItem>
        </HelperText>
        {endpointFields.map(textField)}
      </FormSection>
    </>
  );
};
