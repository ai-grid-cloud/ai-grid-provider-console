// Ported from krisv/ai-grid-cloud-provider-poc src/app/pages/models/ModelWizard.tsx at 62319b8.
// Adapted from packages/model-serving/src/components/deploymentWizard/ModelDeploymentWizard.tsx,
// steps/ModelSourceStep.tsx, steps/ModelDeploymentStep.tsx and steps/ReviewStep.tsx.
// upstream commit: 8051fbbea117457b4da4074fb2856b732e6677a4
// Standalone fields replace cluster catalogs and dynamic deployment plugins.
import { useState } from 'react';
import { Link, useNavigate } from 'react-router-dom';
import {
  Alert,
  Breadcrumb,
  BreadcrumbItem,
  Button,
  Content,
  DescriptionList,
  DescriptionListDescription,
  DescriptionListGroup,
  DescriptionListTerm,
  Form,
  FormGroup,
  FormHelperText,
  HelperText,
  HelperTextItem,
  Stack,
  StackItem,
  TextInput,
  Title,
  Wizard,
  WizardFooter,
  WizardStep,
  useWizardContext,
} from '@patternfly/react-core';
import type { UserService } from '../../api/ConsoleService';
import { ServiceError } from '../../api/ConsoleService';
import type { ModelsService } from '../../api/models';
import type { CreateModelRequest } from '../../api/types';
import { K8sNameDescriptionField } from '../../components/K8sNameDescriptionField/K8sNameDescriptionField';
import { useK8sNameDescriptionFieldData } from '../../components/K8sNameDescriptionField/useK8sNameDescriptionFieldData';
import { MultiSelection } from '../../components/MultiSelection';
import { useServiceData } from '../../hooks/useServiceData';
import { createModelSchema } from '../../validation';
import { RuntimeArgsField } from './fields/RuntimeArgsField';
import { filterRuntimeArgsForContainer, type RuntimeArgsFieldData } from './fields/runtimeArgs';

type Props = { service: ModelsService & UserService };

type FooterProps = {
  sourceValid: boolean;
  deploymentValid: boolean;
  locationsValid: boolean;
  saving: boolean;
  error?: string;
  onSave: () => Promise<void>;
  onCancel: () => void;
};

const DeploymentFooter: React.FC<FooterProps> = ({
  sourceValid,
  deploymentValid,
  locationsValid,
  saving,
  error,
  onSave,
  onCancel,
}) => {
  const { activeStep, goToNextStep, goToPrevStep } = useWizardContext();
  const final = activeStep.id === 'summary-step';
  const valid =
    activeStep.id === 'source-model-step'
      ? sourceValid
      : sourceValid &&
        deploymentValid &&
        (!['locations-step', 'summary-step'].includes(String(activeStep.id)) || locationsValid);
  return (
    <>
      <div className="pf-v6-u-px-lg">
        {error && (
          <Alert isInline variant="danger" title="Unable to save deployment">
            {error}
          </Alert>
        )}
      </div>
      <WizardFooter
        activeStep={activeStep}
        onNext={() => (final ? onSave() : goToNextStep())}
        onBack={() => goToPrevStep()}
        onClose={onCancel}
        nextButtonText={final ? 'Save deployment' : 'Next'}
        isNextDisabled={saving || !valid}
        isBackDisabled={saving}
        cancelButtonProps={{ isDisabled: saving }}
        nextButtonProps={{ isLoading: saving }}
      />
    </>
  );
};

const Help: React.FC<{ children: React.ReactNode }> = ({ children }) => (
  <FormHelperText>
    <HelperText>
      <HelperTextItem>{children}</HelperTextItem>
    </HelperText>
  </FormHelperText>
);

const notAvailable = (err: unknown, what: string) =>
  err instanceof ServiceError && err.isNotImplemented ? `${what} not available on this backend yet.` : undefined;

/** The five-step deploy wizard at /models/deploy. */
export const ModelWizard: React.FC<Props> = ({ service }) => {
  const navigate = useNavigate();
  const [availableLocations, locationsLoaded, locationsError, reloadLocations] = useServiceData<string[]>(
    () => service.listLocations(),
    [],
    0,
  );
  const [locations, setLocations] = useState<string[]>([]);
  const { data: nameDescData, onDataChange: onNameDescChange } = useK8sNameDescriptionFieldData();
  const [modelUri, setModelUri] = useState('');
  const [modelName, setModelName] = useState('');
  const [runtimeImage, setRuntimeImage] = useState('');
  const [replicas, setReplicas] = useState('1');
  const [cpu, setCpu] = useState('2');
  const [memory, setMemory] = useState('4Gi');
  const [gpuCount, setGpuCount] = useState('0');
  const [runtimeArgs, setRuntimeArgs] = useState<RuntimeArgsFieldData>({ enabled: false, args: [] });
  const [saving, setSaving] = useState(false);
  const [error, setError] = useState<string>();

  const input: CreateModelRequest = {
    name: nameDescData.k8sName.value,
    displayName: nameDescData.name,
    description: nameDescData.description,
    modelUri,
    modelName,
    runtimeImage,
    replicas: Number(replicas),
    cpu,
    memory,
    gpuCount: Number(gpuCount),
    runtimeArgs: filterRuntimeArgsForContainer(runtimeArgs.args),
    locations,
  };
  const sourceValid = createModelSchema
    .pick({ modelUri: true, modelName: true })
    .safeParse({ modelUri, modelName }).success;
  const deploymentValid =
    replicas !== '' && gpuCount !== '' && createModelSchema.omit({ locations: true }).strip().safeParse(input).success;
  const locationsValid =
    locationsLoaded &&
    !locationsError &&
    locations.length > 0 &&
    locations.every((location) => availableLocations.includes(location));

  const cancel = () => navigate('/models');
  const save = async () => {
    if (saving || !sourceValid || !deploymentValid || !locationsValid) return;
    setSaving(true);
    setError(undefined);
    try {
      await service.createModel(input);
      navigate('/models', { state: { notice: 'Model deployment saved' } });
    } catch (err) {
      setError(
        notAvailable(err, 'Saving model deployments is') ??
          (err instanceof Error ? err.message : 'The deployment could not be saved.'),
      );
      setSaving(false);
    }
  };

  const review: [string, string][] = [
    ['Model deployment name', nameDescData.name],
    ['Model', modelName],
    ['Model URI', modelUri],
    ['Runtime image', runtimeImage],
    ['Replica count', replicas],
    ['CPU', cpu],
    ['Memory', memory],
    ['GPUs', gpuCount],
    ['Additional runtime arguments', input.runtimeArgs.join(' ') || 'None'],
    ['Locations', locations.join(', ')],
  ];

  const locationsStep = () => {
    if (locationsError) {
      return (
        <Alert isInline variant="danger" title="Error loading locations">
          {notAvailable(locationsError, 'Locations are') ?? locationsError.message}
          <Button variant="link" onClick={() => void reloadLocations()}>
            Retry
          </Button>
        </Alert>
      );
    }
    if (!locationsLoaded) {
      return <p>Loading locations…</p>;
    }
    if (availableLocations.length === 0) {
      return (
        <Alert isInline variant="warning" title="No locations available">
          Locations become available when an AI Grid member is provisioned and Ready.
        </Alert>
      );
    }
    return (
      <FormGroup label="Locations" fieldId="model-locations" isRequired>
        <MultiSelection
          id="model-locations-select"
          inputId="model-locations"
          ariaLabel="Locations"
          placeholder="Select locations"
          selectionRequired
          noSelectedOptionsMessage="Select at least one location."
          value={availableLocations.map((location) => ({
            id: location,
            name: location,
            selected: locations.includes(location),
          }))}
          setValue={(options) => setLocations(options.filter((option) => option.selected).map((o) => String(o.id)))}
          isDisabled={saving}
        />
        <Help>Select locations with Ready, provisioned AI Grid members.</Help>
      </FormGroup>
    );
  };

  return (
    <Stack hasGutter>
      <StackItem>
        <Breadcrumb>
          <BreadcrumbItem>
            <Link to="/models">Models</Link>
          </BreadcrumbItem>
          <BreadcrumbItem isActive>Deploy model</BreadcrumbItem>
        </Breadcrumb>
      </StackItem>
      <StackItem>
        <Title headingLevel="h2">Deploy model</Title>
        <Content component="p">Configure a model deployment.</Content>
      </StackItem>
      <StackItem>
        <Wizard
          className="portal-model-wizard"
          isProgressive={false}
          onClose={cancel}
          footer={
            <DeploymentFooter
              sourceValid={sourceValid}
              deploymentValid={deploymentValid}
              locationsValid={locationsValid}
              saving={saving}
              error={error}
              onSave={save}
              onCancel={cancel}
            />
          }
        >
          <WizardStep name="Model details" id="source-model-step">
            <Form maxWidth="750px">
              <FormGroup label="Model URI" fieldId="model-uri" isRequired>
                <TextInput
                  id="model-uri"
                  value={modelUri}
                  onChange={(_event, value) => setModelUri(value)}
                  isRequired
                />
                <Help>
                  Enter the model location, for example hf://org/model, oci://registry/model:tag, s3://bucket/path or
                  pvc://claim/path.
                </Help>
              </FormGroup>
              <FormGroup label="Model name" fieldId="model-alias" isRequired>
                <TextInput
                  id="model-alias"
                  value={modelName}
                  onChange={(_event, value) => setModelName(value)}
                  isRequired
                />
                <Help>The model name exposed by the inference service, for example org/model.</Help>
              </FormGroup>
            </Form>
          </WizardStep>
          <WizardStep name="Model deployment" id="model-deployment-step" isDisabled={!sourceValid || saving}>
            <Form maxWidth="750px">
              <K8sNameDescriptionField
                data={nameDescData}
                onDataChange={onNameDescChange}
                dataTestId="model-name-desc"
                nameLabel="Model deployment name"
                nameHelperText="Choose a resource name of at most 63 characters."
              />
              <FormGroup label="Runtime image" fieldId="runtime-image" isRequired>
                <TextInput
                  id="runtime-image"
                  value={runtimeImage}
                  onChange={(_event, value) => setRuntimeImage(value)}
                  isRequired
                />
                <Help>Container image for the serving runtime.</Help>
              </FormGroup>
              <FormGroup label="Replica count" fieldId="deployment-replicas" isRequired>
                <TextInput
                  id="deployment-replicas"
                  type="number"
                  min={1}
                  max={99}
                  value={replicas}
                  onChange={(_event, value) => setReplicas(value)}
                  isRequired
                />
              </FormGroup>
              <FormGroup label="CPU" fieldId="deployment-cpu" isRequired>
                <TextInput id="deployment-cpu" value={cpu} onChange={(_event, value) => setCpu(value)} isRequired />
                <Help>Positive cores or millicores, for example 2 or 500m.</Help>
              </FormGroup>
              <FormGroup label="Memory" fieldId="deployment-memory" isRequired>
                <TextInput
                  id="deployment-memory"
                  value={memory}
                  onChange={(_event, value) => setMemory(value)}
                  isRequired
                />
                <Help>For example 4Gi or 512Mi.</Help>
              </FormGroup>
              <FormGroup label="GPU count" fieldId="deployment-gpus" isRequired>
                <TextInput
                  id="deployment-gpus"
                  type="number"
                  min={0}
                  max={64}
                  value={gpuCount}
                  onChange={(_event, value) => setGpuCount(value)}
                  isRequired
                />
              </FormGroup>
            </Form>
          </WizardStep>
          <WizardStep
            name="Advanced settings"
            id="advanced-options-step"
            isDisabled={!sourceValid || !deploymentValid || saving}
          >
            <Form maxWidth="750px">
              <RuntimeArgsField data={runtimeArgs} onChange={setRuntimeArgs} />
            </Form>
          </WizardStep>
          <WizardStep name="Locations" id="locations-step" isDisabled={!sourceValid || !deploymentValid || saving}>
            <Form maxWidth="750px">{locationsStep()}</Form>
          </WizardStep>
          <WizardStep
            name="Review"
            id="summary-step"
            isDisabled={!sourceValid || !deploymentValid || !locationsValid || saving}
          >
            <DescriptionList>
              {review.map(([term, value]) => (
                <DescriptionListGroup key={term}>
                  <DescriptionListTerm>{term}</DescriptionListTerm>
                  <DescriptionListDescription>{value}</DescriptionListDescription>
                </DescriptionListGroup>
              ))}
            </DescriptionList>
          </WizardStep>
        </Wizard>
      </StackItem>
    </Stack>
  );
};
