// Ported from krisv/ai-grid-cloud-provider-poc src/app/pages/models/ModelWizard.tsx at 62319b8.
// Adapted from packages/model-serving/src/components/deploymentWizard/ModelDeploymentWizard.tsx,
// steps/ModelSourceStep.tsx, steps/ModelDeploymentStep.tsx and steps/ReviewStep.tsx.
// upstream commit: 8051fbbea117457b4da4074fb2856b732e6677a4
// Standalone fields replace cluster catalogs and dynamic deployment plugins.
import { useMemo, useRef, useState } from 'react';
import { Link, useNavigate } from 'react-router-dom';
import {
  Alert,
  AlertActionLink,
  Breadcrumb,
  BreadcrumbItem,
  ExpandableSection,
  Flex,
  Form,
  FormGroup,
  FormHelperText,
  FormSelect,
  FormSelectOption,
  HelperText,
  HelperTextItem,
  PageSection,
  TextInput,
  Wizard,
  WizardStep,
  useWizardContext,
} from '@patternfly/react-core';
import { ServiceError } from '../../api/ConsoleService';
import { ConsoleWizardFooter } from '../../components/ConsoleWizardFooter';
import { CountInput } from '../../components/CountInput';
import { DetailsList } from '../../components/DetailsList';
import { DetailsSection } from '../../components/DetailsSection';
import { K8sNameDescriptionField } from '../../components/K8sNameDescriptionField/K8sNameDescriptionField';
import { useK8sNameDescriptionFieldData } from '../../components/K8sNameDescriptionField/useK8sNameDescriptionFieldData';
import { MultiSelection } from '../../components/MultiSelection';
import { PageHeader } from '../../components/PageHeader';
import { ReadOnlyField } from '../../components/ReadOnlyField';
import { useConfirmDiscard } from '../../hooks/useConfirmDiscard';
import { createModelSchema, fieldMessage } from '../../validation';
import { RuntimeArgsField } from './fields/RuntimeArgsField';
import { filterRuntimeArgsForContainer, runtimeArgsOf, type RuntimeArgsFieldData } from './fields/runtimeArgs';
import { DEFAULT_REPLICAS, sameSet, updateRequestOf, type ModelInput } from './modelRequests';
import { titleOf, type ModelView } from './modelView';
import { OlderServedNameAlert } from './OlderServedNameAlert';
import { useModelWrites, usePlacementClusters } from './useModels';
import { deploymentNameFromUri, locationLabel, modelPath, siteNamesOf } from './modelUtils';
import { type ModelServer, modelServerLabel, modelServers } from './modelServers';
import { useClusterList } from '../clusters/useClusters';

type Props = {
  /** The model to edit; without it the wizard deploys a new one. */
  model?: ModelView;
};

const steps = {
  source: 'source-model-step',
  deployment: 'model-deployment-step',
  locations: 'locations-step',
  review: 'summary-step',
} as const;

/**
 * The longest id a new model can have, as Models/Create allows (backend checkNewModelIDLength):
 * ai-gateway-controller names a Service provider-selection-required-<id> without shortening it, so a
 * longer id breaks routing for every model on that ingress site. An existing model keeps its id.
 */
const MAX_NEW_MODEL_ID_LENGTH = 63 - 'provider-selection-required-'.length;

const defaults = { replicas: String(DEFAULT_REPLICAS), cpu: '2', memory: '4Gi', gpuCount: '0' };

/** A resource the model was deployed without, shown in its read-only field. */
const NOT_SET = 'Not set';

const fixedReason = {
  source: 'The model a deployment serves is fixed. Deploy a new model to serve another one.',
  // Says what the field is without claiming a model deployed earlier serves its resource name: one
  // written before the backend served models as their ids can keep another.
  served:
    'Tenants send this name as the model in their requests, and it can’t be changed here. A model deployed from this console is served as its resource name.',
  resources: 'Resources are set when the model is deployed. Deploy it again to change them.',
};

/** The wizard's starting values: the defaults when deploying, the model's own when editing. */
const initialValues = (model?: ModelView) => ({
  modelUri: model?.modelUri ?? '',
  runtimeImage: model?.runtimeImage ?? '',
  replicas: model?.replicas !== undefined ? String(model.replicas) : defaults.replicas,
  cpu: model ? (model.cpu ?? '') : defaults.cpu,
  memory: model ? (model.memory ?? '') : defaults.memory,
  gpuCount: model ? String(model.gpuCount ?? 0) : defaults.gpuCount,
  runtimeArgs: runtimeArgsOf(model?.env),
  // Only a `name In [...]` placement can be edited as locations (placementClustersOf).
  locations: model?.placementClusters ?? [],
});

/** A field's help line, replaced by the field's error while it has one. */
const Help: React.FC<{ children: React.ReactNode; error?: string; id?: string }> = ({ children, error, id }) => (
  <FormHelperText>
    <HelperText id={id}>
      <HelperTextItem variant={error ? 'error' : 'default'}>{error ?? children}</HelperTextItem>
    </HelperText>
  </FormHelperText>
);

const notAvailable = (err: unknown, what: string) =>
  err instanceof ServiceError && err.isNotImplemented ? `${what} not available on this backend yet.` : undefined;

/** Says which chosen locations are no longer offered; undefined when none are. */
const goneLocationsError = (names: string[]) =>
  names.length === 0
    ? undefined
    : `${names.join(', ')} ${names.length === 1 ? 'is' : 'are'} no longer available. Remove ${names.length === 1 ? 'it' : 'them'} to continue.`;

/**
 * The Review step: an alert about the choices or the model first, if there is one, spaced as the
 * sections are; each section's Edit link goes back to its step.
 */
const ReviewStep: React.FC<{
  sections: { title: string; step: string; items: { term: string; value?: string }[] }[];
  alert?: React.ReactNode;
}> = ({ sections, alert }) => {
  const { goToStepById } = useWizardContext();
  return (
    <Flex
      direction={{ default: 'column' }}
      flexWrap={{ default: 'nowrap' }}
      spaceItems={{ default: 'spaceItemsXl' }}
      data-testid="model-review"
    >
      {alert}
      {sections.map((section) => (
        <DetailsSection key={section.title} title={section.title} onEdit={() => goToStepById(section.step)}>
          <DetailsList items={section.items} hideEmpty aria-label={section.title} />
        </DetailsSection>
      ))}
    </Flex>
  );
};

/**
 * The four-step deploy wizard at /models/deploy: source, deployment, locations, review. With
 * `model` it edits that deployment at /models/:id/edit through the same steps: every step can be
 * opened from the start, the fields the console doesn't edit are read-only, and Save changes sends
 * only what changed (Models/Update with its mask).
 */
export const ModelWizard: React.FC<Props> = ({ model }) => {
  const navigate = useNavigate();
  const editing = !!model;
  const [start] = useState(() => initialValues(model));
  // Editing any other placement as locations would change what else it selects.
  const locationsEditable = !model || model.placementClusters !== undefined;
  const replicasEditable = !model?.autoscaled;
  const writes = useModelWrites();
  const {
    data: availableLocations,
    loaded: locationsLoaded,
    error: locationsError,
    refresh: reloadLocations,
  } = usePlacementClusters();
  const { data: clusters, refresh: reloadClusters } = useClusterList();
  // Site names by location label, for a placement the console didn't write (its model.locations).
  const siteNames = useMemo(() => siteNamesOf(clusters), [clusters]);
  // Site names by cluster name, for the clusters Models/ListPlacementClusters offers and the placement takes.
  const clusterSiteNames = useMemo(
    () => new Map(clusters.flatMap((c) => (c.siteName ? [[c.name, c.siteName] as const] : []))),
    [clusters],
  );
  // AI Grid members ListPlacementClusters doesn't offer: not Available, not Compliant, or not a cluster
  // that serves models (role inference or combined).
  const unavailableMembers = clusters.filter((c) => c.aiGridEnabled && !availableLocations.includes(c.name)).length;
  const [locations, setLocations] = useState<string[]>(start.locations);
  // True from entering the Locations step until its locations reload answers; Next waits for it.
  const [reloadingLocations, setReloadingLocations] = useState(false);
  const reloadRef = useRef(0);
  // Chosen locations that a reload no longer offers. They stay as chips, so the user sees why Next is disabled.
  const goneLocations = locationsLoaded ? locations.filter((location) => !availableLocations.includes(location)) : [];
  // Like the text fields, Locations shows its error only once the user has changed it.
  const [locationsTouched, setLocationsTouched] = useState(false);
  const { data: nameDescData, onDataChange: onNameDescChange } = useK8sNameDescriptionFieldData({
    maxLength: MAX_NEW_MODEL_ID_LENGTH,
    // A k8sName makes the resource name read-only, as a deployed one is.
    initialData: model ? { name: titleOf(model), description: model.description ?? '', k8sName: model.id } : undefined,
  });
  const [modelUri, setModelUri] = useState(start.modelUri);
  const [runtimeImage, setRuntimeImage] = useState(start.runtimeImage);
  const [replicas, setReplicas] = useState(start.replicas);
  const [cpu, setCpu] = useState(start.cpu);
  const [memory, setMemory] = useState(start.memory);
  const [gpuCount, setGpuCount] = useState(start.gpuCount);
  // A deployed model keeps its presets; the choice is only made when deploying.
  // No default: the grid's sites can be GPU or CPU-only clusters, so the user picks one.
  const [serverId, setServerId] = useState<ModelServer['id'] | ''>('');
  const server = modelServers.find((s) => s.id === serverId);
  const chooseServer = (id: ModelServer['id']) => {
    setServerId(id);
    // A GPU server starts at one GPU (none is what crash-loops); a CPU server hides the field,
    // so it goes back to its default rather than keep a value nobody can see or fix.
    if (!modelServers.find((s) => s.id === id)?.usesGpus) setGpuCount(defaults.gpuCount);
    else if (gpuCount === defaults.gpuCount || gpuCount === '') setGpuCount('1');
  };
  const usesGpus = editing || Boolean(server?.usesGpus);
  const [runtimeArgs, setRuntimeArgs] = useState<RuntimeArgsFieldData>({
    enabled: start.runtimeArgs.length > 0,
    args: start.runtimeArgs,
  });
  // A field shows its error only once the user has left it, as Locations does.
  const [touched, setTouched] = useState<ReadonlySet<string>>(new Set());
  const touch = (field: string) => setTouched((prev) => (prev.has(field) ? prev : new Set(prev).add(field)));
  const [saving, setSaving] = useState(false);
  const [error, setError] = useState<string>();

  const input: ModelInput = {
    name: nameDescData.k8sName.value,
    displayName: nameDescData.name,
    description: nameDescData.description,
    modelUri: modelUri.trim(),
    runtimeImage,
    replicas: Number(replicas),
    cpu,
    memory,
    // A CPU server asks for no GPUs, whatever the hidden field last held.
    gpuCount: usesGpus ? Number(gpuCount) : 0,
    runtimeArgs: filterRuntimeArgsForContainer(runtimeArgs.args),
    baseRefs: model ? model.baseRefs : (server?.baseRefs ?? []),
    clusters: locations,
  };
  const edited: ModelInput = { ...input, clusters: locationsEditable ? locations : start.locations };
  const isDirty = model
    ? updateRequestOf(model, edited) !== undefined
    : [modelUri, runtimeImage, nameDescData.name, nameDescData.description].some((v) => v !== '') ||
      replicas !== defaults.replicas ||
      cpu !== defaults.cpu ||
      memory !== defaults.memory ||
      gpuCount !== defaults.gpuCount ||
      serverId !== '' ||
      runtimeArgs.enabled ||
      locations.length > 0;
  const detailsPath = model ? modelPath(model) : '';
  const leave = () => navigate(model ? detailsPath : '/models');
  const [requestLeave, discardModal] = useConfirmDiscard(isDirty && !saving, leave);

  // Every field this checks is required, so a field the user left empty says so.
  const shownError = (field: keyof typeof createModelSchema.shape, value: string, parse?: (text: string) => unknown) =>
    !touched.has(field)
      ? undefined
      : value.trim()
        ? fieldMessage(createModelSchema.shape[field], value, parse)
        : 'Required.';
  const modelUriError = shownError('modelUri', modelUri);
  const runtimeImageError = shownError('runtimeImage', runtimeImage);
  const replicasError = shownError('replicas', replicas, Number);
  const cpuError = shownError('cpu', cpu);
  const memoryError = shownError('memory', memory);
  // KServe's GPU preset with no GPUs is what crash-loops on a CPU-only node.
  const gpusMissing = !editing && Boolean(server?.usesGpus) && gpuCount !== '' && Number(gpuCount) < 1;
  const serverError = !editing && touched.has('server') && !server ? 'Required.' : undefined;
  const gpuCountError =
    shownError('gpuCount', gpuCount, Number) ??
    (touched.has('gpuCount') && gpusMissing ? 'A GPU model server needs at least 1 GPU.' : undefined);
  // A deployed model's source, name and resources are fixed, so only what an edit can change is checked.
  const sourceValid = editing || createModelSchema.pick({ modelUri: true }).safeParse({ modelUri }).success;
  const deploymentValid = editing
    ? createModelSchema
        .pick({ displayName: true, description: true })
        .safeParse({ displayName: input.displayName, description: input.description }).success &&
      // A model deployed without an image keeps none until one is entered.
      (runtimeImage === start.runtimeImage ||
        createModelSchema.shape.runtimeImage.safeParse(input.runtimeImage).success) &&
      // The deploy wizard's limits apply to a count the user sets, not to one the model already has.
      (!replicasEditable ||
        replicas === start.replicas ||
        (replicas !== '' && createModelSchema.shape.replicas.safeParse(input.replicas).success))
    : server !== undefined &&
      // The schema allows any model's id (63); a new one is held to MAX_NEW_MODEL_ID_LENGTH by the field.
      !nameDescData.k8sName.state.invalidLength &&
      replicas !== '' &&
      gpuCount !== '' &&
      !gpusMissing &&
      createModelSchema.omit({ locations: true }).strip().safeParse(input).success;
  // An edit that keeps the locations doesn't depend on which locations are offered right now.
  const locationsChanged = !editing || !sameSet(locations, start.locations);
  const locationsValid =
    !locationsEditable ||
    (!locationsChanged && locations.length > 0) ||
    (locationsLoaded && !reloadingLocations && !locationsError && locations.length > 0 && goneLocations.length === 0);
  const isStepValid = (step: string) =>
    step === steps.source
      ? sourceValid
      : sourceValid &&
        deploymentValid &&
        (step === steps.deployment || locationsValid) &&
        // Saving an edit that changes nothing would only bump the version.
        (step !== steps.review || !editing || isDirty);

  const save = async () => {
    if (saving || !sourceValid || !deploymentValid || !locationsValid || (editing && !isDirty)) return;
    setSaving(true);
    setError(undefined);
    try {
      if (model) {
        await writes.updateModel(model, edited);
        navigate(detailsPath, { state: { notice: 'Model deployment updated' } });
      } else {
        await writes.createModel(input);
        // Replaces the deploy form in history, so Back doesn't land on it, empty.
        navigate('/models', { replace: true, state: { notice: 'Model deployed' } });
      }
    } catch (err) {
      setError(
        notAvailable(err, editing ? 'Editing models is' : 'Deploying models is') ??
          (editing && err instanceof ServiceError && err.status === 409
            ? 'This model deployment changed since you opened it. Reload the page to edit the current version.'
            : err instanceof Error
              ? err.message
              : editing
                ? 'The model deployment could not be updated.'
                : 'The model could not be deployed.'),
      );
      setSaving(false);
    }
  };

  // A placement the console doesn't edit, or none, as the review and the step show it.
  const placedAt = () => {
    if (!model?.placed) return 'No placement';
    return model.locations.length > 0
      ? model.locations.map((l) => locationLabel(l, siteNames)).join(', ')
      : 'No locations chosen yet';
  };

  const locationsStep = () => {
    if (!locationsEditable) {
      return (
        <ReadOnlyField
          label="Locations"
          fieldId="model-locations"
          value={placedAt()}
          reason={
            model?.placed
              ? 'This placement selects clusters by more than location, so it can’t be edited as locations here.'
              : 'This model has no placement, so it isn’t placed on any AI Grid location.'
          }
        />
      );
    }
    if (locationsError) {
      return (
        <Alert
          isInline
          variant="danger"
          title="Error loading locations"
          actionLinks={<AlertActionLink onClick={() => void reloadLocations()}>Retry</AlertActionLink>}
        >
          {notAvailable(locationsError, 'Locations are') ?? locationsError.message}
        </Alert>
      );
    }
    if (!locationsLoaded) {
      return <p>Loading locations...</p>;
    }
    // With chosen locations to show, the field stays, so the user can see and remove them.
    if (availableLocations.length === 0 && goneLocations.length === 0) {
      return (
        <Alert isInline variant="warning" title="No locations available">
          Locations become available when an AI Grid member that serves models is Available and provisioned.
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
          selectionRequired={locationsTouched}
          noSelectedOptionsMessage="Select at least one location."
          errorMessage={
            locationsChanged
              ? goneLocationsError(goneLocations.map((location) => locationLabel(location, clusterSiteNames)))
              : undefined
          }
          value={[
            ...availableLocations.map((location) => ({
              id: location,
              name: locationLabel(location, clusterSiteNames),
              selected: locations.includes(location),
            })),
            ...goneLocations.map((location) => ({
              id: location,
              name: locationLabel(location, clusterSiteNames),
              selected: true,
              chipOnly: true,
            })),
          ]}
          setValue={(options) => {
            setLocationsTouched(true);
            setLocations(options.filter((option) => option.selected).map((o) => String(o.id)));
          }}
          isDisabled={saving}
        />
        <Help>
          The model runs on each AI Grid cluster you choose.
          {unavailableMembers > 0 &&
            ` ${unavailableMembers} AI Grid ${unavailableMembers === 1 ? 'cluster isn’t' : 'clusters aren’t'} listed because ${unavailableMembers === 1 ? 'it isn’t' : 'they aren’t'} Available and provisioned, or ${unavailableMembers === 1 ? 'doesn’t' : 'don’t'} serve models.`}
        </Help>
      </FormGroup>
    );
  };

  // A hint only, from the GPU counts the clusters list already carries: a GPU server on a cluster
  // with no GPUs never schedules, and a CPU server on a GPU cluster leaves its GPUs unused.
  const serverMismatch = (() => {
    if (editing || !server) return undefined;
    const chosen = clusters.filter(
      (c) => c.aiGridEnabled && (locations.includes(c.name) || (c.location && locations.includes(c.location))),
    );
    const mismatched = chosen
      .filter((c) => c.gpuCapacity !== undefined && (server.usesGpus ? c.gpuCapacity === 0 : c.gpuCapacity > 0))
      .map((c) => c.name)
      .sort();
    if (mismatched.length === 0) return undefined;
    const names = mismatched.join(', ');
    return server.usesGpus
      ? `${names} ${mismatched.length === 1 ? 'reports' : 'report'} no GPUs, so ${server.label} can't run there.`
      : `${names} ${mismatched.length === 1 ? 'has' : 'have'} GPUs that ${server.label} doesn't use.`;
  })();

  const review = [
    {
      title: 'Source',
      step: steps.source,
      items: [
        { term: 'Model URI', value: modelUri },
        // A deployed model keeps the name it is served as; a new one is served as its resource name.
        ...(model ? [{ term: 'Model name', value: model.modelName ?? model.id }] : []),
      ],
    },
    {
      title: 'Deployment',
      step: steps.deployment,
      items: [
        { term: 'Deployment name', value: nameDescData.name },
        ...(model ? [] : [{ term: 'Name tenants call', value: nameDescData.k8sName.value }]),
        { term: 'Description', value: nameDescData.description },
        { term: 'Model server', value: modelServerLabel(input.baseRefs) },
        { term: 'Runtime image', value: runtimeImage },
        { term: 'Replicas', value: replicasEditable ? replicas : 'Autoscaled' },
        { term: 'CPU', value: cpu },
        { term: 'Memory', value: memory },
        { term: 'GPUs', value: String(input.gpuCount) },
        { term: 'Additional runtime arguments', value: input.runtimeArgs.join(' ') },
      ],
    },
    {
      title: 'Locations',
      step: steps.locations,
      items: [
        {
          term: 'Locations',
          value: locationsEditable ? locations.map((l) => locationLabel(l, clusterSiteNames)).join(', ') : placedAt(),
        },
      ],
    },
  ];

  return (
    <>
      <PageHeader
        title={model ? `Edit ${titleOf(model)}` : 'Deploy model'}
        description={
          model ? 'Change the model deployment’s settings and locations.' : 'Deploy a model to AI Grid locations.'
        }
        breadcrumb={
          <Breadcrumb>
            <BreadcrumbItem>
              <Link to="/models">Models</Link>
            </BreadcrumbItem>
            {model && (
              <BreadcrumbItem>
                <Link to={detailsPath}>{titleOf(model)}</Link>
              </BreadcrumbItem>
            )}
            <BreadcrumbItem isActive>{model ? 'Edit' : 'Deploy model'}</BreadcrumbItem>
          </Breadcrumb>
        }
      />
      <PageSection type="wizard" hasBodyWrapper={false} isFilled>
        <Wizard
          isProgressive={false}
          onClose={requestLeave}
          onStepChange={(_event, current, previous) => {
            // Start a new deployment's name from the model URI's last segment, once.
            if (!editing && previous.id === steps.source && !nameDescData.name) {
              onNameDescChange('name', deploymentNameFromUri(modelUri));
            }
            // A cluster can change state while the earlier steps are filled in, so offer what is available now.
            if (current.id === steps.locations && locationsEditable) {
              const reload = ++reloadRef.current;
              setReloadingLocations(true);
              void reloadLocations().then(() => {
                if (reload === reloadRef.current) setReloadingLocations(false);
              });
              // The clusters only name the sites and count the unlisted members, so Next doesn't wait for them.
              void reloadClusters();
            }
          }}
          footer={
            <ConsoleWizardFooter
              submitStepId={steps.review}
              submitLabel={editing ? 'Save changes' : 'Deploy'}
              errorTitle={editing ? 'Unable to update model deployment' : 'Unable to deploy model'}
              isStepValid={isStepValid}
              saving={saving}
              error={error}
              onSubmit={save}
              onCancel={requestLeave}
            />
          }
        >
          <WizardStep name="Source" id={steps.source}>
            <Form maxWidth="750px">
              {editing ? (
                <>
                  {model && <OlderServedNameAlert model={model} />}
                  <ReadOnlyField label="Model URI" fieldId="model-uri" value={modelUri} reason={fixedReason.source} />
                  <ReadOnlyField
                    label="Model name"
                    fieldId="model-alias"
                    value={model?.modelName ?? model?.id ?? ''}
                    reason={fixedReason.served}
                  />
                </>
              ) : (
                <>
                  <FormGroup label="Model URI" fieldId="model-uri" isRequired>
                    <TextInput
                      id="model-uri"
                      aria-describedby="model-uri-help"
                      value={modelUri}
                      onChange={(_event, value) => setModelUri(value)}
                      onBlur={() => touch('modelUri')}
                      validated={modelUriError ? 'error' : 'default'}
                      isRequired
                    />
                    <Help id="model-uri-help" error={modelUriError}>
                      Enter the model location, for example hf://org/model, oci://registry/model:tag, s3://bucket/path
                      or pvc://claim/path.
                    </Help>
                  </FormGroup>
                </>
              )}
            </Form>
          </WizardStep>
          <WizardStep name="Deployment" id={steps.deployment} isDisabled={!sourceValid || saving}>
            <Form maxWidth="750px">
              <K8sNameDescriptionField
                data={nameDescData}
                onDataChange={onNameDescChange}
                dataTestId="model-name-desc"
                nameLabel="Deployment name"
                nameHelperText={
                  editing
                    ? undefined
                    : `Use at most ${MAX_NEW_MODEL_ID_LENGTH} characters: the AI gateway adds a 28-character prefix to this name, and the result must fit the 63-character Kubernetes name limit. Tenants send it as the model in their requests.`
                }
              />
              {editing ? (
                <ReadOnlyField
                  label="Model server"
                  fieldId="model-server"
                  value={modelServerLabel(input.baseRefs)}
                  reason={fixedReason.resources}
                />
              ) : (
                <FormGroup label="Model server" fieldId="model-server" isRequired>
                  <FormSelect
                    id="model-server"
                    aria-describedby="model-server-help"
                    value={serverId}
                    onChange={(_event, value) => chooseServer(value as ModelServer['id'])}
                    onBlur={() => touch('server')}
                    validated={serverError ? 'error' : 'default'}
                    isRequired
                  >
                    <FormSelectOption isPlaceholder isDisabled value="" label="Select a model server" />
                    {modelServers.map((s) => (
                      <FormSelectOption key={s.id} value={s.id} label={s.label} />
                    ))}
                  </FormSelect>
                  <Help id="model-server-help" error={serverError}>
                    {server?.description ?? 'Choose the build that matches the hardware of the clusters you deploy to.'}
                  </Help>
                </FormGroup>
              )}
              <FormGroup label="Runtime image" fieldId="runtime-image" isRequired>
                <TextInput
                  id="runtime-image"
                  aria-describedby="runtime-image-help"
                  value={runtimeImage}
                  onChange={(_event, value) => setRuntimeImage(value)}
                  onBlur={() => touch('runtimeImage')}
                  validated={runtimeImageError ? 'error' : 'default'}
                  isRequired
                />
                <Help id="runtime-image-help" error={runtimeImageError}>
                  Container image for the serving runtime. It must match the model server, such as a vLLM CPU image for
                  vLLM on CPU.
                </Help>
              </FormGroup>
              {replicasEditable ? (
                <FormGroup label="Replicas" fieldId="deployment-replicas" isRequired>
                  <CountInput
                    id="deployment-replicas"
                    label="Replicas"
                    min={1}
                    max={99}
                    value={replicas}
                    onChange={setReplicas}
                    onBlur={() => touch('replicas')}
                    describedBy="deployment-replicas-help"
                    validated={replicasError ? 'error' : 'default'}
                  />
                  <Help id="deployment-replicas-help" error={replicasError}>
                    Between 1 and 99.
                  </Help>
                </FormGroup>
              ) : (
                <ReadOnlyField
                  label="Replicas"
                  fieldId="deployment-replicas"
                  value="Autoscaled"
                  reason="KEDA scales this model, so it has no fixed replica count."
                />
              )}
              {editing ? (
                <>
                  {/* A model deployed without requests has none to show. */}
                  <ReadOnlyField
                    label="CPU"
                    fieldId="deployment-cpu"
                    value={cpu || NOT_SET}
                    reason={fixedReason.resources}
                  />
                  <ReadOnlyField
                    label="Memory"
                    fieldId="deployment-memory"
                    value={memory || NOT_SET}
                    reason={fixedReason.resources}
                  />
                  <ReadOnlyField
                    label="GPUs"
                    fieldId="deployment-gpus"
                    value={gpuCount}
                    reason={fixedReason.resources}
                  />
                </>
              ) : (
                <>
                  <FormGroup label="CPU" fieldId="deployment-cpu" isRequired>
                    <TextInput
                      id="deployment-cpu"
                      aria-describedby="deployment-cpu-help"
                      value={cpu}
                      onChange={(_event, value) => setCpu(value)}
                      onBlur={() => touch('cpu')}
                      validated={cpuError ? 'error' : 'default'}
                      isRequired
                    />
                    <Help id="deployment-cpu-help" error={cpuError}>
                      Positive cores or millicores, for example 2 or 500m.
                    </Help>
                  </FormGroup>
                  <FormGroup label="Memory" fieldId="deployment-memory" isRequired>
                    <TextInput
                      id="deployment-memory"
                      aria-describedby="deployment-memory-help"
                      value={memory}
                      onChange={(_event, value) => setMemory(value)}
                      onBlur={() => touch('memory')}
                      validated={memoryError ? 'error' : 'default'}
                      isRequired
                    />
                    <Help id="deployment-memory-help" error={memoryError}>
                      For example 4Gi or 512Mi.
                    </Help>
                  </FormGroup>
                  {usesGpus && (
                    <FormGroup label="GPUs" fieldId="deployment-gpus" isRequired>
                      <CountInput
                        id="deployment-gpus"
                        label="GPUs"
                        min={1}
                        max={64}
                        value={gpuCount}
                        onChange={setGpuCount}
                        onBlur={() => touch('gpuCount')}
                        describedBy="deployment-gpus-help"
                        validated={gpuCountError ? 'error' : 'default'}
                      />
                      <Help id="deployment-gpus-help" error={gpuCountError}>
                        Between 1 and 64.
                      </Help>
                    </FormGroup>
                  )}
                </>
              )}
              <ExpandableSection toggleText="Advanced settings" isIndented>
                <RuntimeArgsField data={runtimeArgs} onChange={setRuntimeArgs} />
              </ExpandableSection>
            </Form>
          </WizardStep>
          <WizardStep name="Locations" id={steps.locations} isDisabled={!sourceValid || !deploymentValid || saving}>
            <Form maxWidth="750px">{locationsStep()}</Form>
          </WizardStep>
          <WizardStep
            name="Review"
            id={steps.review}
            isDisabled={!sourceValid || !deploymentValid || !locationsValid || saving}
          >
            <ReviewStep
              sections={review}
              alert={
                model ? (
                  <OlderServedNameAlert model={model} />
                ) : (
                  serverMismatch && (
                    <Alert isInline variant="warning" title={serverMismatch} data-testid="model-server-mismatch" />
                  )
                )
              }
            />
          </WizardStep>
        </Wizard>
      </PageSection>
      {discardModal}
    </>
  );
};
