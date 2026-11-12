// Ported from krisv/ai-grid-cloud-provider-poc src/app/pages/tenants/TenantFormWizard.tsx at 62319b8.
// Combined adaptation of OSAC TenantCreatePage and IdentityProviderCreateWizard.
// Source commit: 8cb0a227e45cc9b17421b6e79ce493ed370ebd5d. Break-glass flow is omitted.
import { useEffect, useRef } from 'react';
import { Form, Wizard, WizardStep, useWizardContext } from '@patternfly/react-core';
import { ConsoleWizardFooter } from '../../components/ConsoleWizardFooter';
import { useConfirmDiscard } from '../../hooks/useConfirmDiscard';
import { IdentityProviderFields } from './IdentityProviderFields';
import type { OrganizationSection } from './OrganizationConfigurationDetails';
import { OrganizationConfigurationDetails } from './OrganizationConfigurationDetails';
import { OrganizationDetailsFields } from './OrganizationDetailsFields';
import type { OrganizationInput, OrganizationView } from './organizationView';
import { useOrganizationForm } from './useOrganizationForm';

type Props = {
  /** The organization to edit; without it the wizard creates one. */
  organization?: OrganizationView;
};

const stepOf: Record<OrganizationSection, string> = {
  details: 'organization-details',
  identityProvider: 'organization-idp',
};

/** The Review step; its Edit links go back to the step that edits each section. */
const ReviewStep: React.FC<{ organization: OrganizationInput }> = ({ organization }) => {
  const { goToStepById } = useWizardContext();
  return (
    <OrganizationConfigurationDetails
      organization={organization}
      variant="review"
      onEditSection={(section) => goToStepById(stepOf[section])}
    />
  );
};

/**
 * When a save is refused with field errors, moves to the first step that shows one: Review shows no
 * fields, and the alert alone doesn't say which field the server meant. Once per refused save
 * (`refused` is a new object each time), so the user can still go back to Review. It sits in the
 * footer, which stays mounted while the steps come and go.
 */
const GoToRefusedField: React.FC<{ refused?: object; errorStep?: string }> = ({ refused, errorStep }) => {
  const { goToStepById } = useWizardContext();
  const handled = useRef<object>(undefined);
  useEffect(() => {
    if (refused && refused !== handled.current && errorStep) {
      handled.current = refused;
      goToStepById(errorStep);
    }
  }, [refused, errorStep, goToStepById]);
  return null;
};

/**
 * Creates an organization in three steps: its details, its identity provider, then a review. With
 * `organization` it edits that one through the same steps: every step can be opened from the start,
 * the name is read-only, an identity provider can be added or changed but not removed, and Save on
 * the Review step stays disabled until something changed.
 */
export const OrganizationFormWizard: React.FC<Props> = ({ organization }) => {
  const editing = !!organization;
  const form = useOrganizationForm(organization);
  const { values, setValues, saving } = form;
  const [requestLeave, discardModal] = useConfirmDiscard(form.isDirty && !saving, form.leave);

  return (
    <>
      <Wizard
        navAriaLabel="Organization onboarding steps"
        onClose={requestLeave}
        footer={
          <>
            <GoToRefusedField
              refused={form.serverErrorsSent}
              errorStep={
                Object.keys(form.detailServerErrors).length
                  ? 'organization-details'
                  : Object.keys(form.idpServerErrors).length
                    ? 'organization-idp'
                    : undefined
              }
            />
            <ConsoleWizardFooter
              submitStepId="organization-review"
              submitLabel={editing ? 'Save' : 'Create organization'}
              errorTitle="Unable to save organization"
              isStepValid={(step) =>
                form.detailsValid &&
                (step === 'organization-details' || form.idpValid) &&
                (step !== 'organization-review' || !editing || form.isDirty)
              }
              saving={saving}
              error={form.error}
              onSubmit={form.save}
              onCancel={requestLeave}
            />
          </>
        }
      >
        <WizardStep name="Organization details" id="organization-details">
          <Form maxWidth="750px">
            <OrganizationDetailsFields
              value={{ name: values.name, domains: values.domains }}
              onChange={(details) => setValues({ ...values, ...details })}
              errors={form.detailErrors}
              serverErrors={form.detailServerErrors}
              isNameEditable={!editing}
              isDisabled={saving}
            />
          </Form>
        </WizardStep>
        <WizardStep name="Identity provider" id="organization-idp" isDisabled={!form.detailsValid || saving}>
          <Form maxWidth="750px">
            <IdentityProviderFields
              value={values.identityProvider}
              serverErrors={form.idpServerErrors}
              onChange={(identityProvider) => setValues({ ...values, identityProvider })}
              savedIssuer={form.savedIssuer}
              isDisabled={saving}
            />
          </Form>
        </WizardStep>
        <WizardStep name="Review" id="organization-review" isDisabled={!form.detailsValid || !form.idpValid || saving}>
          <ReviewStep organization={form.toSave} />
        </WizardStep>
      </Wizard>
      {discardModal}
    </>
  );
};
