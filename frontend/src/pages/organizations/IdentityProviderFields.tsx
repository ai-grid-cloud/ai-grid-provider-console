// Ported from krisv/ai-grid-cloud-provider-poc src/app/pages/tenants/IdentityProviderFields.tsx at 62319b8.
// Adapted from OSAC IdpGeneralStep.tsx and IdpConfigurationStep.tsx at 8cb0a227e45cc9b17421b6e79ce493ed370ebd5d.
import { useState } from 'react';
import {
  Checkbox,
  Form,
  FormGroup,
  FormHelperText,
  HelperText,
  HelperTextItem,
  TextArea,
  TextInput,
} from '@patternfly/react-core';
import type { IdentityProvider, OidcConfig } from '../../api/types';
import { fieldErrorsOf, identityProviderSchema } from '../../validation';

type TextKey = Exclude<keyof OidcConfig, 'clientSecretSecret' | 'validateSignature'>;

const configFields: { key: TextKey; label: string; required?: boolean }[] = [
  { key: 'clientId', label: 'Client ID', required: true },
  { key: 'issuer', label: 'Issuer', required: true },
  { key: 'authorizationUrl', label: 'Authorization URL', required: true },
  { key: 'tokenUrl', label: 'Token URL', required: true },
  { key: 'defaultScopes', label: 'Default scopes' },
  { key: 'userInfoUrl', label: 'User info URL' },
  { key: 'jwksUrl', label: 'JWKS URL' },
  { key: 'logoutUrl', label: 'Logout URL' },
];

type Props = {
  value: IdentityProvider;
  onChange: (provider: IdentityProvider) => void;
  /** The server's messages, keyed by path under identityProvider; shown whether or not the field was touched. */
  serverErrors?: Record<string, string>;
};

const ErrorText: React.FC<{ message: string }> = ({ message }) => (
  <FormHelperText>
    <HelperText>
      <HelperTextItem variant="error">{message}</HelperTextItem>
    </HelperText>
  </FormHelperText>
);

export const IdentityProviderFields: React.FC<Props> = ({ value, onChange, serverErrors = {} }) => {
  const [touched, setTouched] = useState<Set<string>>(() => new Set());
  const errors = fieldErrorsOf(identityProviderSchema, value);
  const error = (path: string): string | undefined =>
    serverErrors[path] ?? (touched.has(path) ? errors[path] : undefined);
  const touch = (path: string) => setTouched((previous) => new Set([...previous, path]));
  const setConfig = (config: Partial<OidcConfig>) => onChange({ ...value, config: { ...value.config, ...config } });
  const secretPath = 'config.clientSecretSecret.name';

  return (
    <Form maxWidth="750px">
      <FormGroup label="Title" fieldId="idp-title">
        <TextInput id="idp-title" value={value.title} onChange={(_event, title) => onChange({ ...value, title })} />
      </FormGroup>
      <FormGroup label="Description" fieldId="idp-description">
        <TextArea
          id="idp-description"
          value={value.description}
          onChange={(_event, description) => onChange({ ...value, description })}
        />
      </FormGroup>
      <FormGroup label="Client secret reference" fieldId="idp-secret-reference" isRequired>
        <TextInput
          id="idp-secret-reference"
          value={value.config.clientSecretSecret.name}
          isRequired
          validated={error(secretPath) ? 'error' : 'default'}
          onBlur={() => touch(secretPath)}
          onChange={(_event, name) => setConfig({ clientSecretSecret: { name } })}
        />
        <FormHelperText>
          <HelperText>
            <HelperTextItem>Enter the name of the secret containing the OIDC client secret.</HelperTextItem>
          </HelperText>
        </FormHelperText>
        {error(secretPath) && <ErrorText message={error(secretPath)!} />}
      </FormGroup>
      {configFields.map((field) => {
        const path = `config.${field.key}`;
        return (
          <FormGroup key={field.key} label={field.label} fieldId={`idp-${field.key}`} isRequired={field.required}>
            <TextInput
              id={`idp-${field.key}`}
              value={value.config[field.key]}
              isRequired={field.required}
              validated={error(path) ? 'error' : 'default'}
              onBlur={() => touch(path)}
              onChange={(_event, text) => setConfig({ [field.key]: text })}
            />
            {field.key === 'defaultScopes' && (
              <FormHelperText>
                <HelperText>
                  <HelperTextItem>Space-separated scopes, for example openid profile email.</HelperTextItem>
                </HelperText>
              </FormHelperText>
            )}
            {error(path) && <ErrorText message={error(path)!} />}
          </FormGroup>
        );
      })}
      <Checkbox
        id="idp-validate-signature"
        label="Validate signature"
        isChecked={value.config.validateSignature}
        onChange={(_event, validateSignature) => setConfig({ validateSignature })}
      />
    </Form>
  );
};
