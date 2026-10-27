// Ported from krisv/ai-grid-cloud-provider-poc src/app/pages/tenants/IdentityProviderFields.tsx at 62319b8.
// Adapted from OSAC IdpGeneralStep.tsx and IdpConfigurationStep.tsx at 8cb0a227e45cc9b17421b6e79ce493ed370ebd5d.
import { useState } from 'react';
import {
  Checkbox,
  FormGroup,
  FormHelperText,
  FormSection,
  HelperText,
  HelperTextItem,
  TextArea,
  TextInput,
} from '@patternfly/react-core';
import type { IdentityProvider, OidcConfig } from '../../api/types';
import { fieldErrorsOf, identityProviderSchema } from '../../validation';

type TextKey = Exclude<keyof OidcConfig, 'clientSecretSecret' | 'validateSignature'>;

type Field = { key: TextKey; label: string; required?: boolean; help?: string };

const connectionFields: Field[] = [
  { key: 'clientId', label: 'Client ID', required: true },
  { key: 'issuer', label: 'Issuer', required: true, help: 'For example https://sso.example.com/realms/acme.' },
];

const endpointFields: Field[] = [
  { key: 'authorizationUrl', label: 'Authorization URL', required: true },
  { key: 'tokenUrl', label: 'Token URL', required: true },
  { key: 'userInfoUrl', label: 'User info URL' },
  { key: 'jwksUrl', label: 'JWKS URL' },
  { key: 'logoutUrl', label: 'Logout URL' },
];

const SECRET_PATH = 'config.clientSecretSecret.name';

type Props = {
  value: IdentityProvider;
  onChange: (provider: IdentityProvider) => void;
  /** The server's messages, keyed by path under identityProvider; shown whether or not the field was touched. */
  serverErrors?: Record<string, string>;
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
export const IdentityProviderFields: React.FC<Props> = ({ value, onChange, serverErrors = {}, isDisabled }) => {
  const [touched, setTouched] = useState<Set<string>>(() => new Set());
  const errors = fieldErrorsOf(identityProviderSchema, value);
  const error = (path: string): string | undefined =>
    serverErrors[path] ?? (touched.has(path) ? errors[path] : undefined);
  const touch = (path: string) => setTouched((previous) => new Set([...previous, path]));
  const setConfig = (config: Partial<OidcConfig>) => onChange({ ...value, config: { ...value.config, ...config } });

  const textField = (field: Field) => {
    const path = `config.${field.key}`;
    return (
      <FormGroup key={field.key} label={field.label} fieldId={`idp-${field.key}`} isRequired={field.required}>
        <TextInput
          id={`idp-${field.key}`}
          value={value.config[field.key]}
          isRequired={field.required}
          isDisabled={isDisabled}
          validated={error(path) ? 'error' : 'default'}
          onBlur={() => touch(path)}
          onChange={(_event, text) => setConfig({ [field.key]: text })}
        />
        <Help error={error(path)}>{field.help}</Help>
      </FormGroup>
    );
  };

  return (
    <>
      <FormGroup label="Title" fieldId="idp-title">
        <TextInput
          id="idp-title"
          value={value.title}
          isDisabled={isDisabled}
          onChange={(_event, title) => onChange({ ...value, title })}
        />
        <Help>The name members see on the sign-in page.</Help>
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
          <Help error={error(SECRET_PATH)}>The name of the Secret that holds the OIDC client secret.</Help>
        </FormGroup>
        {textField(connectionFields[1])}
        <FormGroup label="Default scopes" fieldId="idp-defaultScopes">
          <TextInput
            id="idp-defaultScopes"
            value={value.config.defaultScopes}
            isDisabled={isDisabled}
            validated={error('config.defaultScopes') ? 'error' : 'default'}
            onBlur={() => touch('config.defaultScopes')}
            onChange={(_event, defaultScopes) => setConfig({ defaultScopes })}
          />
          <Help error={error('config.defaultScopes')}>Space-separated, for example openid profile email.</Help>
        </FormGroup>
        <Checkbox
          id="idp-validate-signature"
          label="Validate signature"
          description="Check the provider's signature on tokens with its JWKS keys."
          isChecked={value.config.validateSignature}
          isDisabled={isDisabled}
          onChange={(_event, validateSignature) => setConfig({ validateSignature })}
        />
      </FormSection>
      <FormSection title="OIDC endpoints" titleElement="h2">
        <HelperText>
          <HelperTextItem>
            The provider lists these in its OpenID configuration, at the issuer URL followed by
            /.well-known/openid-configuration.
          </HelperTextItem>
        </HelperText>
        {endpointFields.map(textField)}
      </FormSection>
    </>
  );
};
