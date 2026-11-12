import { useState } from 'react';
import { render, screen } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import type { IdentityProvider } from './organizationView';
import { IdentityProviderFields } from './IdentityProviderFields';

const blank: IdentityProvider = {
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
};

const Form = () => {
  const [value, setValue] = useState(blank);
  return <IdentityProviderFields value={value} onChange={setValue} />;
};

it('requires the JWKS URL only while Validate signature is on', async () => {
  const user = userEvent.setup();
  render(<Form />);
  const jwks = screen.getByRole('textbox', { name: /JSON Web Key Set \(JWKS\) URL/ });
  expect(jwks).toBeRequired();

  await user.click(jwks);
  await user.tab();
  expect(screen.getByText('Enter the JWKS URL, or turn off Validate signature.')).toBeInTheDocument();

  await user.click(screen.getByRole('checkbox', { name: 'Validate signature' }));
  expect(jwks).not.toBeRequired();
  expect(screen.queryByText('Enter the JWKS URL, or turn off Validate signature.')).not.toBeInTheDocument();
});

it('requires the JWKS URL again when Validate signature is turned back on', async () => {
  const user = userEvent.setup();
  render(<Form />);
  const jwks = screen.getByRole('textbox', { name: /JSON Web Key Set \(JWKS\) URL/ });
  const validate = screen.getByRole('checkbox', { name: 'Validate signature' });
  await user.click(jwks);
  await user.tab();

  await user.click(validate);
  expect(jwks).not.toBeRequired();
  expect(screen.queryByText('Enter the JWKS URL, or turn off Validate signature.')).not.toBeInTheDocument();

  await user.click(validate);
  expect(validate).toBeChecked();
  expect(jwks).toBeRequired();
  expect(screen.getByText('Enter the JWKS URL, or turn off Validate signature.')).toBeInTheDocument();
});

const SAVED_ISSUER_HELP =
  "The issuer can be edited only until a user logs in through this identity provider. After that, to use a different issuer, remove the users' links to this identity provider in Keycloak, or create a new organization.";
const NEW_ISSUER_WARNING = 'A new issuer is saved only if no user has logged in through this identity provider';

const STORED_ISSUER = 'https://sso.example.com/realms/acme';

const Saved = () => {
  const [value, setValue] = useState({ ...blank, config: { ...blank.config, issuer: STORED_ISSUER } });
  return <IdentityProviderFields value={value} onChange={setValue} savedIssuer={STORED_ISSUER} />;
};

it('keeps a saved issuer editable, and says until when it can change', async () => {
  const user = userEvent.setup();
  render(<Saved />);
  const field = screen.getByRole('textbox', { name: /Issuer/ });
  expect(field).not.toHaveAttribute('readonly');
  expect(screen.getByText(SAVED_ISSUER_HELP)).toBeVisible();
  await user.clear(field);
  await user.paste('https://sso.example.com/realms/acme-corp');
  expect(field).toHaveValue('https://sso.example.com/realms/acme-corp');
  // Validated as on create: a cleared issuer is an error, which replaces the help.
  await user.clear(field);
  await user.tab();
  expect(field).toHaveAttribute('aria-invalid', 'true');
  expect(screen.queryByText(SAVED_ISSUER_HELP)).not.toBeInTheDocument();
});

it('warns under a saved issuer while it differs from the stored one, whatever its validation', async () => {
  const user = userEvent.setup();
  render(<Saved />);
  const field = screen.getByRole('textbox', { name: /Issuer/ });
  expect(screen.queryByText(NEW_ISSUER_WARNING)).not.toBeInTheDocument();

  await user.clear(field);
  await user.paste('https://sso.example.com/realms/acme-corp');
  expect(screen.getByText(NEW_ISSUER_WARNING)).toBeVisible();
  // An invalid issuer keeps the warning beside its error.
  await user.clear(field);
  await user.tab();
  expect(field).toHaveAttribute('aria-invalid', 'true');
  expect(screen.getByText(NEW_ISSUER_WARNING)).toBeVisible();
  // Back to the stored issuer, there is nothing to warn about.
  await user.click(field);
  await user.paste(STORED_ISSUER);
  expect(screen.queryByText(NEW_ISSUER_WARNING)).not.toBeInTheDocument();
});

it('gives a new issuer an example, without the saved issuer help or warning', async () => {
  const user = userEvent.setup();
  render(<Form />);
  expect(screen.getByText('For example https://sso.example.com/realms/acme.')).toBeVisible();
  expect(screen.queryByText(SAVED_ISSUER_HELP)).not.toBeInTheDocument();
  await user.click(screen.getByRole('textbox', { name: /Issuer/ }));
  await user.paste('https://sso.example.com/realms/acme');
  expect(screen.queryByText(NEW_ISSUER_WARNING)).not.toBeInTheDocument();
});
