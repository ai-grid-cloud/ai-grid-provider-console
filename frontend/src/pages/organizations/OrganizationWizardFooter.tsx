// Ported from krisv/ai-grid-cloud-provider-poc src/app/pages/tenants/TenantWizardFooter.tsx at 62319b8.
import { Alert, WizardFooter, useWizardContext } from '@patternfly/react-core';

type Props = {
  detailsValid: boolean;
  idpValid: boolean;
  saving: boolean;
  error?: string;
  onSave: () => Promise<void>;
  onCancel: () => void;
  isEdit: boolean;
};

/** Next becomes Create organization or Save changes on Review; Back on the first step cancels. */
export const OrganizationWizardFooter: React.FC<Props> = ({
  detailsValid,
  idpValid,
  saving,
  error,
  onSave,
  onCancel,
  isEdit,
}) => {
  const { activeStep, goToNextStep, goToPrevStep } = useWizardContext();
  const review = activeStep.id === 'tenant-review';
  const valid = detailsValid && (activeStep.id === 'tenant-details' || idpValid);
  return (
    <>
      <div className="pf-v6-u-px-lg">
        {error && (
          <Alert isInline variant="danger" title="Unable to save organization">
            {error}
          </Alert>
        )}
      </div>
      <WizardFooter
        activeStep={activeStep}
        onNext={() => (review ? onSave() : goToNextStep())}
        onBack={() => (activeStep.id === 'tenant-details' ? onCancel() : goToPrevStep())}
        onClose={onCancel}
        nextButtonText={review ? (isEdit ? 'Save changes' : 'Create organization') : 'Next'}
        isNextDisabled={saving || !valid}
        isBackDisabled={saving}
        cancelButtonProps={{ isDisabled: saving }}
        nextButtonProps={{ isLoading: saving }}
      />
    </>
  );
};
