/**
 * The model servers the Deploy model wizard offers: each is the KServe LLMInferenceServiceConfig
 * presets a model's spec.baseRefs names, as the ODH dashboard's accelerator choice adds one
 * (packages/llmd-serving/src/deployments/configs.ts, applyConfigRef). A preset sets the runtime
 * image and its environment (the CPU one sets VLLM_CPU_KVCACHE_SPACE and OMP_NUM_THREADS); the
 * backend still requires an image of its own, which overrides the preset's.
 * Without baseRefs KServe applies its default preset, v3-6-0-kserve-config-llm-template, which
 * is for NVIDIA GPUs: on a CPU-only node vLLM then asks for most of the node's memory and
 * crash-loops. The names are RHOAI 3.6's, as on every spoke in redhat-ods-applications.
 */
export type ModelServer = {
  id: 'vllm-cpu' | 'vllm-gpu';
  label: string;
  description: string;
  baseRefs: string[];
  /** Whether the server needs GPUs, so the wizard asks for a count. */
  usesGpus: boolean;
};

export const modelServers: readonly ModelServer[] = [
  {
    id: 'vllm-cpu',
    label: 'vLLM on CPU',
    description: 'For x86_64 clusters without GPUs.',
    baseRefs: ['v3-6-0-kserve-config-llm-template-cpu'],
    usesGpus: false,
  },
  {
    id: 'vllm-gpu',
    label: 'vLLM on NVIDIA GPU',
    description: 'For clusters with NVIDIA GPUs.',
    baseRefs: [],
    usesGpus: true,
  },
];

const sameList = (a: readonly string[], b: readonly string[]) =>
  a.length === b.length && a.every((value, i) => value === b[i]);

/** The server whose presets are exactly these; undefined for presets the console doesn't offer. */
export const modelServerOf = (baseRefs: readonly string[] | undefined): ModelServer | undefined =>
  modelServers.find((server) => sameList(server.baseRefs, baseRefs ?? []));

/** A model's server by name, or its presets when the console doesn't offer them. */
export const modelServerLabel = (baseRefs: readonly string[]) => modelServerOf(baseRefs)?.label ?? baseRefs.join(', ');
