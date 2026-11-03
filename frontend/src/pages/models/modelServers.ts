/**
 * The accelerator configurations the Deploy model wizard offers, from the backend's
 * Models/ListServingOptions: one list for every cluster, from the console chart's defaults
 * (values.yaml, servingOptions) and the provider admin's custom ConfigMap. An accelerator
 * configuration (in code, a model server) is an OpenShift AI accelerator preset, an
 * LLMInferenceServiceConfig a model's spec.base_refs names, as the OpenShift AI dashboard's
 * Accelerator configuration field adds one (packages/llmd-serving/src/deployments/configs.ts,
 * applyConfigRef). A preset sets the runtime image and its environment, so a model on one may leave
 * its image empty (ModelContainer.image in the backend's model_type.proto).
 */
import { useQuery } from '@connectrpc/connect-query';
import type { BaseRefOption, ModelsListServingOptionsResponse } from '../../gen/ai_grid/v1/models_service_pb';
import { listServingOptions } from '../../gen/ai_grid/v1/models_service-Models_connectquery';
import { useLoaded, type Loaded } from '../clusters/useClusters';

export type ModelServer = {
  /** The preset's full name, the value spec.base_refs takes. */
  name: string;
  label: string;
  description: string;
  /** Node resources the preset needs, such as nvidia.com/gpu; empty runs on CPUs. */
  accelerators: string[];
  /** Whether the server needs an accelerator, so the wizard asks for a count. */
  usesGpus: boolean;
};

export type ServingOptions = { servers: ModelServer[] };

const toServer = (option: BaseRefOption): ModelServer => ({
  name: option.name,
  label: option.displayName || option.name,
  description: option.description,
  accelerators: [...option.accelerators],
  usesGpus: option.accelerators.length > 0,
});

const servingOptionsOf = (answer: ModelsListServingOptionsResponse | undefined): ServingOptions => ({
  servers: (answer?.baseRefs ?? []).map(toServer),
});

/** The backend's accelerator configurations. */
export const useServingOptions = (): Loaded<ServingOptions> =>
  useLoaded(useQuery(listServingOptions, {}, { retry: false }), servingOptionsOf);

/**
 * What the wizard says about where a configuration runs, from the accelerators it needs: OpenShift
 * AI installs a GPU preset only on clusters with that accelerator, so a model on one fails elsewhere.
 */
export const serverSuitsText = (server: ModelServer) =>
  server.usesGpus
    ? `Only for clusters whose nodes have ${server.accelerators.join(' or ')}: OpenShift AI installs this accelerator configuration only there, and the model fails on any other cluster you select.`
    : 'For any cluster: OpenShift AI installs this accelerator configuration on every cluster.';

/**
 * A model's configuration as the details pages know it without the list: its presets. A model on
 * presets may leave its image to them (setsImage).
 */
export const modelServerOf = (baseRefs: readonly string[] | undefined) =>
  baseRefs && baseRefs.length > 0 ? { setsImage: true } : undefined;

/** A model's configuration by its display name when the list has it, else by its presets' names. */
export const modelServerLabel = (baseRefs: readonly string[], servers: readonly ModelServer[] = []) =>
  baseRefs.map((ref) => servers.find((s) => s.name === ref)?.label ?? ref).join(', ');

/** What the pages show for the runtime image of a model that leaves it to its presets. */
export const PRESET_IMAGE = 'The accelerator configuration’s image';
