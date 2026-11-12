// Ported from krisv/ai-grid-cloud-provider-poc src/app/pages/models/ModelWizard.tsx at 62319b8.
// Adapted from packages/model-serving/src/components/deploymentWizard/ModelDeploymentWizard.tsx,
// steps/ModelSourceStep.tsx, steps/ModelDeploymentStep.tsx and steps/ReviewStep.tsx.
// upstream commit: 8051fbbea117457b4da4074fb2856b732e6677a4
// Standalone fields replace cluster catalogs and dynamic deployment plugins.
import { useMemo, useRef, useState } from 'react';
import { Link, useNavigate, useSearchParams } from 'react-router-dom';
import {
  Alert,
  AlertActionLink,
  Breadcrumb,
  BreadcrumbItem,
  Checkbox,
  ExpandableSection,
  Flex,
  Form,
  FormGroup,
  FormHelperText,
  HelperText,
  HelperTextItem,
  PageSection,
  Radio,
  Spinner,
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
import { useConsoleSession } from '../../context/useConsoleSession';
import { useConfirmDiscard } from '../../hooks/useConfirmDiscard';
import { fieldMessage, modelFieldsSchema, requireImageWithoutNvidia } from '../../validation';
import { RuntimeArgsField } from './fields/RuntimeArgsField';
import { filterRuntimeArgsForContainer, runtimeArgsOf, type RuntimeArgsFieldData } from './fields/runtimeArgs';
import {
  DEFAULT_IMAGE,
  DEFAULT_IMAGE_HELP,
  NVIDIA_GPU,
  acceleratorLabel,
  acceleratorsText,
  envWithHardware,
  hardwareEnv,
  knownAccelerators,
  matchingHardware,
  wholeCount,
  mayUseDefaultImage,
  runtimeImageHelp,
} from './modelHardware';
import { DEFAULT_REPLICAS, sameSet, updateRequestOf, type ModelInput } from './modelRequests';
import { titleOf, type ModelView } from './modelView';
import { OlderServedNameAlert } from './OlderServedNameAlert';
import { isModelDraft } from './modelDraft';
import { useBackgroundWrites } from '../../notifications/useBackgroundWrites';
import { useModelWrites, usePlacementClusters } from './useModels';
import { deploymentNameFromUri, modelPath } from './modelUtils';
import { useClusterList } from '../clusters/useClusters';
import { roleOf } from '../clusters/roles';
import type { ClusterView } from '../clusters/clusterView';
import { listOf } from '../../notifications/writeText';

type Props = {
  /** The model to edit; without it the wizard deploys a new one. */
  model?: ModelView;
};

const steps = {
  source: 'source-model-step',
  deployment: 'model-deployment-step',
  clusters: 'clusters-step',
  review: 'summary-step',
} as const;

/** What the wizard starts from where the selected hardware sets no default. */
const defaults = { replicas: String(DEFAULT_REPLICAS), cpu: '2', memory: '4Gi', accelerators: '1' };

/** The most accelerators the wizard requests (modelFieldsSchema's acceleratorCount). */
const MAX_ACCELERATORS = 64;

/**
 * vLLM on CPU sizes its KV cache for the model's whole context: Qwen3-0.6B's default of 40,960
 * tokens needs 4.38 GiB, more than CPU only's VLLM_CPU_KVCACHE_SPACE of 4 GiB, and runs with
 * --max-model-len=8192.
 */
const CPU_CONTEXT_HINT = 'For long-context models on CPU, set --max-model-len in Advanced settings.';

/**
 * Why an edit can't change the name users send: the backend serves every model as its id and
 * refuses any other name (normalizeServedName in the backend's models_git.go). Says what the field
 * is without claiming a model deployed earlier serves its id: one written before the backend served
 * models as their ids keeps another name until its next update.
 */
const SERVED_NAME_FIXED = 'Users send this name as the model in their requests. It cannot be edited.';

/** The wizard's starting values: the defaults when deploying, the model's own when editing. */
const initialValues = (model?: ModelView) => ({
  modelUri: model?.modelUri ?? '',
  replicas: model?.replicas !== undefined ? String(model.replicas) : defaults.replicas,
  runtimeArgs: runtimeArgsOf(model?.env),
  // Only a `name In [...]` placement can be edited as a list of clusters (placementClustersOf).
  clusterNames: model?.placementClusters ?? [],
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
  err instanceof ServiceError && err.isNotImplemented ? `${what} not available on this AI Grid backend.` : undefined;

/**
 * Why ListPlacementClusters leaves out an AI Grid cluster, from what Clusters/List says of it: the RPC
 * offers the members that are Available (Ready), Compliant with the ready Policy (Provisioned) and
 * whose role is inference or combined (ai_grid.v1 Models.ListPlacementClusters). None for a member
 * that Clusters/List shows meeting all three, which the two reads disagree on only for a moment.
 */
const notListedReasons = (c: ClusterView) => {
  const role = roleOf(c.labels);
  return [
    c.status !== 'Ready' && 'not Ready',
    c.provisioningStatus !== 'Provisioned' && 'not Provisioned',
    !role ? 'no role' : role.value === 'ingress' && 'Ingress role',
  ].filter((r): r is string => !!r);
};

/** Which AI Grid clusters the Clusters step lists, as ListPlacementClusters offers them (notListedReasons). */
const listedClustersRule = (
  <>
    This list includes only clusters that have the <strong>Ready</strong> cluster status, the{' '}
    <strong>Provisioned</strong> AI Grid status, and the <strong>Inference</strong> or{' '}
    <strong>Ingress and inference</strong> role.
  </>
);

/** "Not listed: site2 (not Ready) and site3 (Ingress role).", for each left-out member. */
const notListedText = (members: ClusterView[]) => {
  const named = members.map((c) => {
    const reasons = notListedReasons(c);
    return reasons.length ? `${c.name} (${reasons.join(', ')})` : c.name;
  });
  return `Not listed: ${listOf(named)}.`;
};

/** Says which chosen clusters are no longer offered; undefined when none are. */
const goneClustersError = (names: string[]) =>
  names.length === 0
    ? undefined
    : `${names.join(', ')} ${names.length === 1 ? 'is' : 'are'} no longer available. Remove ${names.length === 1 ? 'it' : 'them'} to continue.`;

type ReviewItem = { term: string; value?: string };

/**
 * The Review step: an alert about the choices or the model first, if there is one, spaced as the
 * sections are; each section's Edit link goes back to its step.
 */
const ReviewStep: React.FC<{
  sections: { title: string; step: string; items: ReviewItem[] }[];
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
 * The four-step deploy wizard at /models/deploy: source, deployment, clusters, review. With
 * `model` it edits that deployment at /models/:id/edit through the same steps, as OpenShift AI's
 * deployment wizard edits one: every step can be opened from the start, the model URI, hardware,
 * resources and presets can be changed, only the id and the name users send stay fixed (with
 * replicas under autoscaling, and clusters a placement selects by more than their names), and Save
 * changes sends only what changed (Models/Update with its mask).
 */
export const ModelWizard: React.FC<Props> = ({ model }) => {
  const navigate = useNavigate();
  const editing = !!model;
  // A deploy the backend refused after the wizard had left reopens it (the toast's ?draft= link)
  // with exactly what was submitted, on Review, with the refusal as the form's error.
  const { draftOf } = useBackgroundWrites();
  const [searchParams] = useSearchParams();
  const [draft] = useState(() => {
    const id = model ? null : searchParams.get('draft');
    const kept = id ? draftOf(id) : undefined;
    return kept?.subject === 'model' && isModelDraft(kept.values)
      ? { values: kept.values, error: kept.error }
      : undefined;
  });
  const [start] = useState(() =>
    draft
      ? {
          modelUri: draft.values.modelUri,
          replicas: draft.values.replicas,
          runtimeArgs: draft.values.runtimeArgs,
          clusterNames: draft.values.clusters,
        }
      : initialValues(model),
  );
  // Editing any other placement as a list of clusters would change what else it selects.
  const clustersEditable = !model || model.placementClusters !== undefined;
  const replicasEditable = !model?.autoscaled;
  const writes = useModelWrites();
  const { config, configError, reloadConfig } = useConsoleSession();
  const hardwareList = config?.models?.hardware ?? [];
  const {
    data: placementClusters,
    loaded: placementClustersLoaded,
    error: placementClustersError,
    refresh: reloadPlacementClusters,
  } = usePlacementClusters();
  const { data: clusters, refresh: reloadClusters } = useClusterList();
  // Each offered cluster's site and region, the description under its name.
  const clusterDescriptions = useMemo(
    () =>
      new Map(
        clusters.flatMap((c) => {
          const where = [c.siteName, c.region].filter(Boolean).join(' · ');
          return where ? [[c.name, where] as const] : [];
        }),
      ),
    [clusters],
  );
  // AI Grid members ListPlacementClusters doesn't offer: not Available, not Compliant, or not a cluster
  // that serves models (role inference or combined).
  const unlistedMembers = clusters.filter((c) => c.aiGridEnabled && !placementClusters.includes(c.name));
  const [clusterNames, setClusterNames] = useState<string[]>(start.clusterNames);
  // True from entering the Clusters step until its placement clusters reload answers; Next waits for it.
  const [reloadingPlacementClusters, setReloadingPlacementClusters] = useState(false);
  const reloadRef = useRef(0);
  // Chosen clusters that a reload no longer offers. They stay as chips, so the user sees why Next is disabled.
  const goneClusters = placementClustersLoaded ? clusterNames.filter((name) => !placementClusters.includes(name)) : [];
  // Like the text fields, Clusters shows its error only once the user has changed it.
  const [clusterNamesTouched, setClusterNamesTouched] = useState(false);
  const { data: nameDescData, onDataChange: onNameDescChange } = useK8sNameDescriptionFieldData({
    maxLength: 63,
    // A k8sName makes the resource name read-only, as a deployed one is; a draft's stays editable,
    // since a taken name is a reason the backend refuses a deploy.
    initialData: model
      ? { name: titleOf(model), description: model.description ?? '', k8sName: model.id }
      : draft
        ? { name: draft.values.displayName, description: draft.values.description, k8sName: draft.values.name }
        : undefined,
    editableK8sName: !model && !!draft,
  });
  const [modelUri, setModelUri] = useState(start.modelUri);
  const [replicas, setReplicas] = useState(start.replicas);
  // Presets an edit removes (spec.base_refs); none can be added.
  const [removePresets, setRemovePresets] = useState(false);
  const presets = model?.baseRefs.join(', ');
  const presetsKept = !!presets && !removePresets;
  // The hardware a new model runs on: the first in the console's list until the user selects
  // another. An edit starts on the entry the model runs on (matchingHardware), or on none, and
  // looks again once its presets are removed; the user can select another. A reopened draft starts
  // on the hardware it was submitted with.
  const [hardwareId, setHardwareId] = useState<string | undefined>(draft?.values.hardwareId);
  const selectedHardware = hardwareList.find((h) => h.id === hardwareId);
  const matchedHardware = model
    ? matchingHardware({ ...model, baseRefs: removePresets ? [] : model.baseRefs }, hardwareList)
    : undefined;
  const hardware = selectedHardware ?? (model ? matchedHardware : hardwareList[0]);
  const accelerator = hardware?.accelerator;
  // The model whose own image, environment and resources an edit shows: a matched entry is only
  // preselected and changes none of them. Selecting another entry applies that one; selecting the
  // matched one again (with the presets removed, the one matched then) goes back to the model's values.
  const own = model && (!selectedHardware || selectedHardware.id === matchedHardware?.id) ? model : undefined;
  // The accelerator count of the model's matching hardware, which an edit starts from, as the
  // whole-number field shows it ("3000m" is 3).
  const storedAccelerators = own && accelerator ? own.acceleratorRequests[0]?.count : undefined;
  const ownAccelerators = storedAccelerators && (wholeCount(storedAccelerators) ?? storedAccelerators);
  // The fields the hardware fills in hold undefined until the user edits them, so they show the
  // selected hardware's value, or for an edit the model's own. An edited CPU, memory or accelerator
  // count is kept when the hardware changes; the image is the hardware's, so selecting hardware
  // replaces an edited one with its own (or none, for the cluster's default). Keeping the presets
  // again selects no hardware, so it changes none of them: a typed image stays.
  const [imageInput, setRuntimeImage] = useState<string | undefined>(draft?.values.image);
  const selectHardware = (id: string) => {
    setHardwareId(id);
    setRuntimeImage(undefined);
  };
  const [cpuInput, setCpu] = useState<string | undefined>(draft?.values.cpu);
  const [memoryInput, setMemory] = useState<string | undefined>(draft?.values.memory);
  const [acceleratorsInput, setAccelerators] = useState<string | undefined>(draft?.values.accelerators);
  const runtimeImage = imageInput ?? (own ? (own.runtimeImage ?? '') : (hardware?.image ?? ''));
  const cpu = cpuInput ?? (own ? (own.cpu ?? '') : (hardware?.defaults?.cpu ?? defaults.cpu));
  const memory = memoryInput ?? (own ? (own.memory ?? '') : (hardware?.defaults?.memory ?? defaults.memory));
  const accelerators =
    acceleratorsInput ?? ownAccelerators ?? String(hardware?.defaults?.accelerators ?? defaults.accelerators);
  const acceleratorsKept = ownAccelerators !== undefined && accelerators === ownAccelerators;
  // The environment besides the runtime arguments: the hardware's for a new model, the model's own
  // for an edit, with the hardware the user selected applied.
  const env = own
    ? own.env.map(({ name, value }) => ({ name, value }))
    : model && hardware
      ? envWithHardware(model.env, hardware, hardwareList)
      : hardwareEnv(hardware);
  const [runtimeArgs, setRuntimeArgs] = useState<RuntimeArgsFieldData>({
    enabled: draft ? draft.values.runtimeArgsEnabled : start.runtimeArgs.length > 0,
    args: start.runtimeArgs,
  });
  // A field shows its error only once the user has left it, as Clusters does.
  const [touched, setTouched] = useState<ReadonlySet<string>>(new Set());
  const touch = (field: string) => setTouched((prev) => (prev.has(field) ? prev : new Set(prev).add(field)));
  const [saving, setSaving] = useState(false);
  const [error, setError] = useState<string | undefined>(draft?.error);

  const input: ModelInput = {
    name: nameDescData.k8sName.value,
    displayName: nameDescData.name,
    description: nameDescData.description,
    modelUri: modelUri.trim(),
    runtimeImage,
    replicas: Number(replicas),
    cpu,
    memory,
    accelerator,
    // Hardware without an accelerator asks for none.
    acceleratorCount: accelerator ? Number(accelerators) : 0,
    // An edit without hardware shows the model's accelerators read-only; one that keeps the model's
    // hardware and count sends its requests as stored, in whatever quantity form they have.
    keepAccelerators: editing && (!hardware || (!!own && (!accelerator || acceleratorsKept))),
    knownAccelerators: knownAccelerators(hardwareList),
    env,
    baseRefs: model && (removePresets ? [] : model.baseRefs),
    runtimeArgs: filterRuntimeArgsForContainer(runtimeArgs.args),
    clusters: clusterNames,
  };
  const edited: ModelInput = { ...input, clusters: clustersEditable ? clusterNames : start.clusterNames };
  const isDirty = model
    ? updateRequestOf(model, edited) !== undefined
    : [modelUri, nameDescData.name, nameDescData.description].some((v) => v !== '') ||
      [imageInput, cpuInput, memoryInput, acceleratorsInput].some((v) => v !== undefined) ||
      (hardwareId !== undefined && hardwareId !== hardwareList[0]?.id) ||
      replicas !== defaults.replicas ||
      runtimeArgs.enabled ||
      clusterNames.length > 0;
  const detailsPath = model ? modelPath(model) : '';
  const leave = () => navigate(model ? detailsPath : '/models');
  const [requestLeave, discardModal] = useConfirmDiscard(isDirty && !saving, leave);

  // Every field this checks is required, so a field the user left empty says so.
  const shownError = (field: keyof typeof modelFieldsSchema.shape, value: string, parse?: (text: string) => unknown) =>
    !touched.has(field)
      ? undefined
      : value.trim()
        ? fieldMessage(modelFieldsSchema.shape[field], value, parse)
        : 'Required';
  // The deploy wizard's limits apply to a value an edit sets, not to one the model already has,
  // which the backend took.
  const kept = (value: string, stored: string | undefined) => editing && value.trim() === (stored ?? '');
  const modelUriError = kept(modelUri, model?.modelUri) ? undefined : shownError('modelUri', modelUri);
  // An empty image runs the cluster's default vLLM image, which is for NVIDIA GPUs
  // (requireImageWithoutNvidia): so the hardware's accelerator decides, or for an edit without
  // hardware, what the model requests. A deployed model's presets set an image of their own.
  const imageAccelerator =
    hardware || !model
      ? accelerator
      : model.acceleratorRequests.some((r) => r.resource === NVIDIA_GPU)
        ? NVIDIA_GPU
        : undefined;
  // An edit that keeps the model's hardware and presets requires it only where it would clear an
  // image the model has: a model stored without one keeps none until one is entered, so editing its
  // other fields doesn't depend on it. Other hardware, or removing the presets, is checked as Deploy is.
  const imageRequired =
    !mayUseDefaultImage(imageAccelerator) && !presetsKept && (!own || own.runtimeImage !== undefined || removePresets);
  const imageMissing = imageRequired && runtimeImage.trim() === '';
  // Hardware without an accelerator, or an edit without hardware of a model that requests none.
  const cpuOnly = hardware ? !accelerator : !!model && model.acceleratorRequests.length === 0;
  const runtimeImageError = !touched.has('runtimeImage')
    ? undefined
    : imageMissing
      ? 'Required'
      : fieldMessage(modelFieldsSchema.shape.runtimeImage, runtimeImage);
  const replicasError = shownError('replicas', replicas, Number);
  // A model deployed without a CPU or memory request keeps none until one is entered.
  const cpuRequired = !own || own.cpu !== undefined;
  const memoryRequired = !own || own.memory !== undefined;
  const resourceError = (field: 'cpu' | 'memory', value: string, required: boolean, stored?: string) =>
    !touched.has(field) || kept(value, stored)
      ? undefined
      : value.trim() || required
        ? shownError(field, value)
        : undefined;
  const cpuError = resourceError('cpu', cpu, cpuRequired, model?.cpu);
  const memoryError = resourceError('memory', memory, memoryRequired, model?.memory);
  const resourceValid = (field: 'cpu' | 'memory', value: string, required: boolean, stored?: string) =>
    kept(value, stored) || (value.trim() === '' ? !required : modelFieldsSchema.shape[field].safeParse(value).success);
  // Hardware with an accelerator needs at least one: without it the model can't use the hardware.
  const acceleratorsValid =
    /^\d+$/.test(accelerators) && Number(accelerators) >= 1 && Number(accelerators) <= MAX_ACCELERATORS;
  const acceleratorsError =
    !touched.has('accelerators') || acceleratorsKept
      ? undefined
      : accelerators === ''
        ? 'Required'
        : acceleratorsValid
          ? undefined
          : `Enter a number from 1 to ${MAX_ACCELERATORS}.`;
  const sourceValid =
    kept(modelUri, model?.modelUri) || modelFieldsSchema.pick({ modelUri: true }).safeParse({ modelUri }).success;
  // The source is checked above; an edit checks the fields it can change, each as Deploy does.
  const deploymentValid = editing
    ? modelFieldsSchema
        .pick({ displayName: true, description: true })
        .safeParse({ displayName: input.displayName, description: input.description }).success &&
      modelFieldsSchema.shape.runtimeImage.safeParse(input.runtimeImage).success &&
      !imageMissing &&
      resourceValid('cpu', cpu, cpuRequired, model?.cpu) &&
      resourceValid('memory', memory, memoryRequired, model?.memory) &&
      (!accelerator || acceleratorsKept || acceleratorsValid) &&
      (!replicasEditable ||
        replicas === start.replicas ||
        (replicas !== '' && modelFieldsSchema.shape.replicas.safeParse(input.replicas).success))
    : hardware !== undefined &&
      replicas !== '' &&
      (!accelerator || acceleratorsValid) &&
      modelFieldsSchema.omit({ locations: true }).strip().superRefine(requireImageWithoutNvidia).safeParse(input)
        .success;
  // An edit that keeps its clusters doesn't depend on which clusters are offered right now.
  const clusterNamesChanged = !editing || !sameSet(clusterNames, start.clusterNames);
  const clusterNamesValid =
    !clustersEditable ||
    (!clusterNamesChanged && clusterNames.length > 0) ||
    (placementClustersLoaded &&
      !reloadingPlacementClusters &&
      !placementClustersError &&
      clusterNames.length > 0 &&
      goneClusters.length === 0);
  const isStepValid = (step: string) =>
    step === steps.source
      ? sourceValid
      : sourceValid &&
        deploymentValid &&
        (step === steps.deployment || clusterNamesValid) &&
        // Saving an edit that changes nothing would only bump the version.
        (step !== steps.review || !editing || isDirty);

  const save = async () => {
    if (saving || !sourceValid || !deploymentValid || !clusterNamesValid || (editing && !isDirty)) return;
    setSaving(true);
    setError(undefined);
    try {
      // The notification center says how the write went, whether the backend answered within the
      // form's short wait or after the form had left (useBackgroundWrites).
      if (model) {
        await writes.updateModel(model, edited);
        navigate(detailsPath);
      } else {
        await writes.createModel(input, {
          displayName: nameDescData.name,
          name: nameDescData.k8sName.value,
          description: nameDescData.description,
          modelUri,
          replicas,
          hardwareId: hardware?.id,
          image: imageInput,
          cpu: cpuInput,
          memory: memoryInput,
          accelerators: acceleratorsInput,
          runtimeArgsEnabled: runtimeArgs.enabled,
          runtimeArgs: runtimeArgs.args,
          clusters: clusterNames,
        });
        // Replaces the deploy form in history, so Back doesn't land on it, empty.
        navigate('/models', { replace: true });
      }
    } catch (err) {
      setError(
        notAvailable(err, editing ? 'Editing models is' : 'Deploying models is') ??
          (editing && err instanceof ServiceError && err.status === 409
            ? 'This model was changed by another user. Reload the page to edit the latest version.'
            : err instanceof Error
              ? err.message
              : editing
                ? 'Unable to update the model.'
                : 'Unable to deploy the model.'),
      );
      setSaving(false);
    }
  };

  // A placement the console doesn't edit, or none, as the review and the step show it.
  const placedAt = () => {
    if (!model?.placed) return 'Not deployed to a cluster';
    return model.selectedClusters.length > 0 ? model.selectedClusters.join(', ') : 'No clusters selected';
  };

  const clustersStep = () => {
    if (!clustersEditable) {
      return (
        <ReadOnlyField
          label="Clusters"
          fieldId="model-clusters"
          value={placedAt()}
          reason={
            model?.placed
              ? "This model's placement selects clusters by more than their names, so its clusters cannot be edited here."
              : 'This model is not deployed to any AI Grid cluster.'
          }
        />
      );
    }
    if (placementClustersError) {
      return (
        <Alert
          isInline
          variant="danger"
          title="Unable to load clusters"
          actionLinks={<AlertActionLink onClick={() => void reloadPlacementClusters()}>Retry</AlertActionLink>}
        >
          {notAvailable(placementClustersError, 'Clusters are') ?? placementClustersError.message}
        </Alert>
      );
    }
    if (!placementClustersLoaded) {
      return <Spinner size="lg" aria-label="Loading clusters" />;
    }
    // With chosen clusters to show, the field stays, so the user can see and remove them.
    if (placementClusters.length === 0 && goneClusters.length === 0) {
      return (
        <Alert isInline variant="warning" title="No clusters available">
          {unlistedMembers.length > 0 ? (
            <>
              {listedClustersRule} {notListedText(unlistedMembers)}
            </>
          ) : (
            'A cluster appears here when it is an AI Grid cluster that serves models, and is Ready and Provisioned.'
          )}
        </Alert>
      );
    }
    return (
      <FormGroup label="Clusters" fieldId="model-clusters" isRequired>
        <MultiSelection
          id="model-clusters-select"
          inputId="model-clusters"
          ariaLabel="Clusters"
          placeholder="Select clusters"
          selectionRequired={clusterNamesTouched}
          noSelectedOptionsMessage="Select at least one cluster."
          errorMessage={clusterNamesChanged ? goneClustersError(goneClusters) : undefined}
          value={[
            ...placementClusters.map((name) => ({
              id: name,
              name,
              description: clusterDescriptions.get(name),
              selected: clusterNames.includes(name),
            })),
            ...goneClusters.map((name) => ({
              id: name,
              name,
              selected: true,
              chipOnly: true,
            })),
          ]}
          setValue={(options) => {
            setClusterNamesTouched(true);
            setClusterNames(options.filter((option) => option.selected).map((o) => String(o.id)));
          }}
          isDisabled={saving}
        />
        <Help>
          Select the AI Grid clusters where the model will run. {listedClustersRule}
          {unlistedMembers.length > 0 && ` ${notListedText(unlistedMembers)}`}
        </Help>
      </FormGroup>
    );
  };

  // The Hardware choice, from the console's config, which App loads once. An edit can save without it.
  const hardwareField = () => {
    if (!config && configError) {
      return (
        <Alert
          isInline
          variant="danger"
          title="Unable to load hardware"
          actionLinks={reloadConfig && <AlertActionLink onClick={() => void reloadConfig()}>Retry</AlertActionLink>}
        >
          {configError.message}
        </Alert>
      );
    }
    if (!config) {
      return <Spinner size="lg" aria-label="Loading hardware" />;
    }
    return (
      <FormGroup role="radiogroup" isStack fieldId="model-hardware" label="Hardware">
        {hardwareList.map((h) => (
          <Radio
            key={h.id}
            id={`model-hardware-${h.id}`}
            name="model-hardware"
            label={h.label}
            description={h.description}
            isChecked={h.id === hardware?.id}
            onChange={() => selectHardware(h.id)}
            // A preset sets an image and environment of its own, which other hardware would conflict with.
            isDisabled={saving || presetsKept}
          />
        ))}
        {presetsKept && <Help>Remove presets to select hardware.</Help>}
        {model && !hardware && !presetsKept && (
          <Help>
            The model&apos;s current settings match none of these. Select one to apply its runtime image, environment,
            and resources.
          </Help>
        )}
      </FormGroup>
    );
  };

  // A hint only, from the GPU counts the clusters list carries, which count NVIDIA GPUs only (the
  // backend reads them from NVIDIA's GPU discovery): NVIDIA hardware on a cluster with none never
  // schedules, and CPU-only hardware on a GPU cluster leaves its GPUs unused. Other accelerators
  // get no hint.
  const hardwareMismatch = (() => {
    if (editing || !hardware || (accelerator && accelerator !== NVIDIA_GPU)) return undefined;
    // The chosen ids are cluster names, never `location` labels.
    const chosen = clusters.filter((c) => c.aiGridEnabled && clusterNames.includes(c.name));
    const mismatched = chosen
      .filter((c) => c.gpuCapacity !== undefined && (accelerator ? c.gpuCapacity === 0 : c.gpuCapacity > 0))
      .map((c) => c.name)
      .sort();
    if (mismatched.length === 0) return undefined;
    const names = mismatched.join(', ');
    const one = mismatched.length === 1;
    return accelerator
      ? `${names} ${one ? 'reports' : 'report'} no NVIDIA GPUs, so the model can't run there`
      : `${names} ${one ? 'has' : 'have'} GPUs that the model doesn't use with ${hardware.label}`;
  })();

  // The hardware selected from the list, or the one the model matches; an edit without either shows
  // what the model requests, which the list, as it is now, may no longer describe.
  const hardwareItems: ReviewItem[] = [
    { term: 'Hardware', value: hardware?.label },
    ...(presets ? [{ term: 'Presets', value: removePresets ? `None (${presets} removed)` : presets }] : []),
  ];
  const acceleratorItems: ReviewItem[] = accelerator
    ? [{ term: acceleratorLabel(accelerator), value: accelerators }]
    : // As Deploy: hardware without an accelerator gets no row; an edit without hardware shows the model's.
      model && !hardware
      ? [{ term: 'Accelerators', value: acceleratorsText(model) }]
      : [];
  // A new URI changes what users of the model are served, under the same name.
  const uriChanged = !!model && input.modelUri !== (model.modelUri ?? '');
  const review = [
    {
      title: 'Source',
      step: steps.source,
      items: [
        { term: 'Model URI', value: modelUri },
        // A deployed model keeps the name it is served as; a new one is served as its resource name.
        ...(model ? [{ term: 'Model name in requests', value: model.modelName ?? model.id }] : []),
      ],
    },
    {
      title: 'Deployment',
      step: steps.deployment,
      items: [
        { term: 'Model name', value: nameDescData.name },
        ...(model ? [] : [{ term: 'Model name in requests', value: nameDescData.k8sName.value }]),
        { term: 'Description', value: nameDescData.description },
        ...hardwareItems,
        // An empty image with presets runs theirs; without presets, the cluster's default.
        { term: 'Runtime image', value: runtimeImage.trim() || (presetsKept ? undefined : DEFAULT_IMAGE) },
        { term: 'Replicas', value: replicasEditable ? replicas : 'Autoscaled' },
        { term: 'CPU', value: cpu },
        { term: 'Memory', value: memory },
        ...acceleratorItems,
        { term: 'Additional runtime arguments', value: input.runtimeArgs.join(' ') },
      ],
    },
    {
      title: 'Clusters',
      step: steps.clusters,
      items: [
        {
          term: 'Clusters',
          value: clustersEditable ? clusterNames.join(', ') : placedAt(),
        },
      ],
    },
  ];

  return (
    <>
      <PageHeader
        title={model ? `Edit ${titleOf(model)}` : 'Deploy model'}
        description={model ? "Edit the model's settings and clusters." : 'Deploy a model to AI Grid clusters.'}
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
          // A reopened draft starts on Review, where its refusal shows.
          startIndex={draft ? 4 : 1}
          isProgressive={false}
          onClose={requestLeave}
          onStepChange={(_event, current, previous) => {
            // Start a new deployment's name from the model URI's last segment, once.
            if (!editing && previous.id === steps.source && !nameDescData.name) {
              onNameDescChange('name', deploymentNameFromUri(modelUri));
            }
            // A cluster can change state while the earlier steps are filled in, so offer what is available now.
            if (current.id === steps.clusters && clustersEditable) {
              const reload = ++reloadRef.current;
              setReloadingPlacementClusters(true);
              void reloadPlacementClusters().then(() => {
                if (reload === reloadRef.current) setReloadingPlacementClusters(false);
              });
              // The clusters only describe the options and count the unlisted members, so Next doesn't wait for them.
              void reloadClusters();
            }
          }}
          footer={
            <ConsoleWizardFooter
              submitStepId={steps.review}
              submitLabel={editing ? 'Save changes' : 'Deploy'}
              errorTitle={editing ? 'Unable to update model' : 'Unable to deploy model'}
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
              {model && <OlderServedNameAlert model={model} />}
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
                  For example, hf://org/model, oci://registry/model:tag, s3://bucket/path, or pvc://claim/path.
                </Help>
              </FormGroup>
              {model && (
                <ReadOnlyField
                  label="Model name in requests"
                  fieldId="model-alias"
                  value={model.modelName ?? model.id}
                  reason={SERVED_NAME_FIXED}
                />
              )}
            </Form>
          </WizardStep>
          <WizardStep name="Deployment" id={steps.deployment} isDisabled={!sourceValid || saving}>
            <Form maxWidth="750px">
              <K8sNameDescriptionField
                data={nameDescData}
                onDataChange={onNameDescChange}
                dataTestId="model-name-desc"
                nameLabel="Model name"
                nameHelperText={
                  editing
                    ? undefined
                    : 'Users send the resource name as the model in their requests. Up to 63 characters.'
                }
              />
              {hardwareField()}
              {presets && (
                <FormGroup label="Presets" fieldId="model-presets">
                  <TextInput
                    id="model-presets"
                    value={presets}
                    readOnlyVariant="default"
                    aria-describedby="model-presets-help"
                  />
                  <FormHelperText>
                    <HelperText id="model-presets-help">
                      <HelperTextItem>
                        Set when the model was deployed. New models are deployed without presets.
                      </HelperTextItem>
                    </HelperText>
                  </FormHelperText>
                  <Checkbox
                    id="model-remove-presets"
                    label="Remove presets"
                    description="The model then uses only the runtime image, environment, and resources set here. Presets can't be added back."
                    isChecked={removePresets}
                    onChange={(_event, checked) => {
                      setRemovePresets(checked);
                      // Keeping the presets puts the model's own hardware back, and with it the model's
                      // image unless the user typed one.
                      if (!checked) setHardwareId(undefined);
                    }}
                    isDisabled={saving}
                  />
                </FormGroup>
              )}
              <FormGroup label="Runtime image" fieldId="runtime-image" isRequired={imageRequired}>
                <TextInput
                  id="runtime-image"
                  aria-describedby="runtime-image-help"
                  value={runtimeImage}
                  onChange={(_event, value) => setRuntimeImage(value)}
                  onBlur={() => touch('runtimeImage')}
                  validated={runtimeImageError ? 'error' : 'default'}
                  isRequired={imageRequired}
                />
                <Help id="runtime-image-help" error={runtimeImageError}>
                  {presetsKept
                    ? 'Leave empty to use the image the presets set.'
                    : !own
                      ? runtimeImageHelp(hardware)
                      : mayUseDefaultImage(imageAccelerator)
                        ? DEFAULT_IMAGE_HELP
                        : "Enter a vLLM image for the model's hardware."}
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
                    From 1 to 99.
                  </Help>
                </FormGroup>
              ) : (
                <ReadOnlyField
                  label="Replicas"
                  fieldId="deployment-replicas"
                  value="Autoscaled"
                  reason="This model scales automatically, so it has no fixed replica count."
                />
              )}
              <FormGroup label="CPU" fieldId="deployment-cpu" isRequired={cpuRequired}>
                <TextInput
                  id="deployment-cpu"
                  aria-describedby="deployment-cpu-help"
                  value={cpu}
                  onChange={(_event, value) => setCpu(value)}
                  onBlur={() => touch('cpu')}
                  validated={cpuError ? 'error' : 'default'}
                  isRequired={cpuRequired}
                />
                <Help id="deployment-cpu-help" error={cpuError}>
                  In cores or millicores. For example, 2 or 500m.
                </Help>
              </FormGroup>
              <FormGroup label="Memory" fieldId="deployment-memory" isRequired={memoryRequired}>
                <TextInput
                  id="deployment-memory"
                  aria-describedby="deployment-memory-help"
                  value={memory}
                  onChange={(_event, value) => setMemory(value)}
                  onBlur={() => touch('memory')}
                  validated={memoryError ? 'error' : 'default'}
                  isRequired={memoryRequired}
                />
                <Help id="deployment-memory-help" error={memoryError}>
                  For example, 4Gi or 512Mi.
                  {/* vLLM sizes its KV cache for the model's whole context, which on CPU often doesn't fit. */}
                  {cpuOnly && ' ' + CPU_CONTEXT_HINT}
                </Help>
              </FormGroup>
              {accelerator ? (
                <FormGroup label={acceleratorLabel(accelerator)} fieldId="deployment-accelerators" isRequired>
                  <CountInput
                    id="deployment-accelerators"
                    label={acceleratorLabel(accelerator)}
                    min={1}
                    max={MAX_ACCELERATORS}
                    value={accelerators}
                    onChange={setAccelerators}
                    onBlur={() => touch('accelerators')}
                    describedBy="deployment-accelerators-help"
                    validated={acceleratorsError ? 'error' : 'default'}
                  />
                  <Help id="deployment-accelerators-help" error={acceleratorsError}>
                    From 1 to {MAX_ACCELERATORS}.
                  </Help>
                </FormGroup>
              ) : (
                // An edit without hardware shows what the model requests, which the list may not describe.
                model &&
                !hardware && (
                  <ReadOnlyField
                    label="Accelerators"
                    fieldId="deployment-accelerators"
                    value={acceleratorsText(model)}
                    reason="Select hardware to edit the accelerators."
                  />
                )
              )}
              <ExpandableSection toggleText="Advanced settings" isIndented>
                <RuntimeArgsField data={runtimeArgs} onChange={setRuntimeArgs} />
              </ExpandableSection>
            </Form>
          </WizardStep>
          <WizardStep name="Clusters" id={steps.clusters} isDisabled={!sourceValid || !deploymentValid || saving}>
            <Form maxWidth="750px">{clustersStep()}</Form>
          </WizardStep>
          <WizardStep
            name="Review"
            id={steps.review}
            isDisabled={!sourceValid || !deploymentValid || !clusterNamesValid || saving}
          >
            <ReviewStep
              sections={review}
              alert={
                model ? (
                  <>
                    <OlderServedNameAlert model={model} />
                    {uriChanged && (
                      <Alert
                        isInline
                        variant="warning"
                        title="This changes the model users are served"
                        data-testid="model-uri-changed"
                      >
                        Once the change rolls out, requests for <code>{model.id}</code> are answered by the model at the
                        new URI. Subscriptions that include this model serve the new one under the same name.
                      </Alert>
                    )}
                  </>
                ) : (
                  hardwareMismatch && (
                    <Alert isInline variant="warning" title={hardwareMismatch} data-testid="model-hardware-mismatch" />
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
