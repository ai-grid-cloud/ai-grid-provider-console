// Ported from krisv/ai-grid-cloud-provider-poc src/app/pages/tenants/TenantFormWizard.tsx at 62319b8.
// Combined adaptation of OSAC TenantCreatePage and IdentityProviderCreateWizard.
// Source commit: 8cb0a227e45cc9b17421b6e79ce493ed370ebd5d. Break-glass flow is omitted.
import { useState } from 'react';
import { useNavigate } from 'react-router-dom';
import {
  Button,
  Form,
  FormGroup,
  FormHelperText,
  FormSection,
  HelperText,
  HelperTextItem,
  TextInput,
  Wizard,
  WizardStep,
} from '@patternfly/react-core';
import { MinusCircleIcon, PlusCircleIcon } from '@patternfly/react-icons';
import { ServiceError } from '../../api/ConsoleService';
import type { OrganizationsService } from '../../api/organizations';
import type { Organization, OrganizationInput } from '../../api/types';
import { fieldErrorsOf, identityProviderSchema, organizationInputSchema, tenantDetailsSchema } from '../../validation';
import { IdentityProviderFields } from './IdentityProviderFields';
import { OrganizationConfigurationDetails } from './OrganizationConfigurationDetails';
import { OrganizationWizardFooter } from './OrganizationWizardFooter';
import { ORGANIZATION_CHANGED, currentServerErrors, emptyOrganizationInput, errorsUnder } from './serverErrors';

type Props = { service: OrganizationsService; initial?: Organization };

const saveErrorMessage = (err: unknown, editing: boolean) => {
  if (err instanceof ServiceError && err.isNotImplemented) {
    return 'Saving organizations is not available on this backend yet.';
  }
  if (editing && err instanceof ServiceError && err.status === 409) {
    return ORGANIZATION_CHANGED;
  }
  return err instanceof Error ? err.message : 'The organization could not be saved.';
};

export const OrganizationFormWizard: React.FC<Props> = ({ service, initial }) => {
  const navigate = useNavigate();
  const [values, setValues] = useState<OrganizationInput>(() =>
    initial
      ? {
          name: initial.name,
          domains: initial.domains,
          // An organization created without one gets the empty form to add it.
          identityProvider: initial.identityProvider ?? emptyOrganizationInput().identityProvider,
        }
      : emptyOrganizationInput(),
  );
  const [saving, setSaving] = useState(false);
  const [error, setError] = useState<string>();
  const [touched, setTouched] = useState(false);
  // The server's field errors and the form values they were returned for.
  const [server, setServer] = useState<{ errors: Record<string, string>; sent: OrganizationInput }>();

  const details = { name: values.name, domains: values.domains };
  const errors = fieldErrorsOf(tenantDetailsSchema, details);
  const detailsValid = Object.keys(errors).length === 0;
  const idpValid = identityProviderSchema.safeParse(values.identityProvider).success;
  const serverErrors = server ? currentServerErrors(server.errors, server.sent, values) : {};
  const detailError = (path: string) => serverErrors[path] ?? (touched ? errors[path] : undefined);
  const detailMessages = [
    ...new Set([
      ...(touched ? Object.values(errors) : []),
      ...Object.entries(serverErrors)
        .filter(([path]) => !path.startsWith('identityProvider.'))
        .map(([, message]) => message),
    ]),
  ];

  const cancel = () => navigate('/organizations');
  const save = async () => {
    const input = organizationInputSchema.safeParse(values);
    if (saving || !input.success) return;
    setSaving(true);
    setError(undefined);
    setServer(undefined);
    try {
      if (initial) {
        await service.updateOrganization(initial.id, input.data, initial.resourceVersion);
      } else {
        await service.createOrganization(input.data);
      }
      navigate('/organizations', {
        state: { notice: initial ? 'Organization configuration saved' : 'Organization and identity provider saved' },
      });
    } catch (err) {
      setError(saveErrorMessage(err, !!initial));
      if (err instanceof ServiceError && err.fieldErrors) {
        setServer({ errors: err.fieldErrors, sent: values });
      }
      setSaving(false);
    }
  };

  return (
    <Wizard
      navAriaLabel="Organization onboarding steps"
      onClose={cancel}
      footer={
        <OrganizationWizardFooter
          detailsValid={detailsValid}
          idpValid={idpValid}
          saving={saving}
          error={error}
          onSave={save}
          onCancel={cancel}
          isEdit={Boolean(initial)}
        />
      }
    >
      <WizardStep name="Organization details" id="tenant-details">
        <Form maxWidth="750px">
          <FormGroup label="Name" fieldId="tenant-name" isRequired>
            <TextInput
              id="tenant-name"
              value={values.name}
              isDisabled={Boolean(initial) || saving}
              isRequired
              onBlur={() => setTouched(true)}
              validated={detailError('name') ? 'error' : 'default'}
              onChange={(_event, name) => setValues({ ...values, name })}
            />
            <FormHelperText>
              <HelperText>
                <HelperTextItem>Use lowercase letters, numbers, and hyphens.</HelperTextItem>
              </HelperText>
            </FormHelperText>
          </FormGroup>
          <FormSection title="Domains">
            {values.domains.map((domain, index) => (
              <FormGroup key={index} label={`Domain ${index + 1}`} fieldId={`tenant-domain-${index}`} isRequired>
                <TextInput
                  id={`tenant-domain-${index}`}
                  value={domain}
                  isRequired
                  onBlur={() => setTouched(true)}
                  validated={detailError(`domains.${index}`) ? 'error' : 'default'}
                  onChange={(_event, text) =>
                    setValues({ ...values, domains: values.domains.map((old, i) => (i === index ? text : old)) })
                  }
                />
                <Button
                  variant="plain"
                  icon={<MinusCircleIcon />}
                  aria-label={`Remove domain ${index + 1}`}
                  onClick={() => setValues({ ...values, domains: values.domains.filter((_, i) => i !== index) })}
                />
              </FormGroup>
            ))}
            <Button
              variant="link"
              icon={<PlusCircleIcon />}
              onClick={() => setValues({ ...values, domains: [...values.domains, ''] })}
            >
              Add domain
            </Button>
          </FormSection>
          {detailMessages.map((message) => (
            <HelperText key={message}>
              <HelperTextItem variant="error">{message}</HelperTextItem>
            </HelperText>
          ))}
        </Form>
      </WizardStep>
      <WizardStep name="Identity provider" id="tenant-idp" isDisabled={!detailsValid || saving}>
        <IdentityProviderFields
          value={values.identityProvider}
          serverErrors={errorsUnder(serverErrors, 'identityProvider')}
          onChange={(identityProvider) => setValues({ ...values, identityProvider })}
        />
      </WizardStep>
      <WizardStep name="Review" id="tenant-review" isDisabled={!detailsValid || !idpValid || saving}>
        <OrganizationConfigurationDetails organization={values} />
      </WizardStep>
    </Wizard>
  );
};
