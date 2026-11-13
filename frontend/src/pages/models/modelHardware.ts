// The Deploy model wizard's Hardware choices, from the console's config (models.hardware, the
// chart's console.models.hardware): what a choice sends, and how the pages word a model's
// accelerators and image. A model is deployed without presets (spec.base_refs): KServe applies its
// default preset, which is for NVIDIA GPUs, then the model's own spec, so the choice's image and
// environment win, and with no image the cluster's default vLLM image for NVIDIA GPUs runs
// (combineBaseRefsConfig in red-hat-data-services/kserve rhoai-3.6,
// pkg/controller/v1alpha2/llmisvc/config_merge.go). That image never becomes ready without NVIDIA
// GPUs, so only NVIDIA hardware may leave the image empty.
//
// A deployed model's pages show it as the model has it; the list can change (a new image digest,
// an entry removed) or fail to load, which only costs the details page its image name. Only the details page's image name (imageNameFor) and the edit wizard
// (matchingHardware, to preselect the entry it runs on) match against the list, and an image the
// list doesn't have shows as the model has it. Selecting another entry in the edit wizard
// applies that entry as the Deploy wizard does.
import type { ModelHardware } from '../../api/types';
import type { ClusterView } from '../clusters/clusterView';
import { roleOf } from '../clusters/roles';
import { RUNTIME_ARGS_ENV, type EnvVar } from './fields/runtimeArgs';
import type { AcceleratorRequest, ModelView } from './modelView';

/** The extended resources of NVIDIA and AMD GPUs; the clusters' GPU counts are NVIDIA's only. */
export const NVIDIA_GPU = 'nvidia.com/gpu';
const AMD_GPU = 'amd.com/gpu';

const isGPU = (resource: string) => resource === NVIDIA_GPU || resource === AMD_GPU;

/**
 * The accelerators the console knows, which an edit that applies hardware replaces: NVIDIA and AMD
 * GPUs, and every accelerator an entry of the list requests. A model's request for any other
 * resource with a `/` in its name (rdma/hca on a model written by hand) is not the console's.
 */
export const knownAccelerators = (list: readonly ModelHardware[]): string[] => [
  ...new Set([NVIDIA_GPU, AMD_GPU, ...list.flatMap((h) => (h.accelerator ? [h.accelerator] : []))]),
];

/** The accelerator count's label: GPUs for NVIDIA and AMD GPUs, Accelerators for any other. */
export const acceleratorLabel = (resource: string) => (isGPU(resource) ? 'GPUs' : 'Accelerators');

/** What a model without an image or presets runs. */
export const DEFAULT_IMAGE = "Default (the cluster's vLLM image for NVIDIA GPUs)";

/** Whether a model may leave its image empty: only on NVIDIA GPUs, which the default image is for. */
export const mayUseDefaultImage = (accelerator: string | undefined) => accelerator === NVIDIA_GPU;

/** A model's runtime image as the pages show it; undefined for none, with presets that set it. */
export const runtimeImageText = (model: Pick<ModelView, 'runtimeImage' | 'baseRefs'>) =>
  model.runtimeImage ?? (model.baseRefs.length === 0 ? DEFAULT_IMAGE : undefined);

/** The Runtime image field's help where the image may be empty. */
export const DEFAULT_IMAGE_HELP = "Leave empty to use the cluster's default vLLM image for NVIDIA GPUs.";

/**
 * The name the hardware gives its image, while `image` is still that image: once the user edits
 * the field the name no longer applies. Compared trimmed, as the requests send it.
 */
export const imageNameOf = (hardware: ModelHardware | undefined, image: string): string | undefined =>
  hardware?.imageName && hardware.image === image.trim() ? hardware.imageName : undefined;

/** The name the hardware list gives this image, compared trimmed; undefined for any other image. */
export const imageNameFor = (list: readonly ModelHardware[], image: string | undefined): string | undefined =>
  image === undefined ? undefined : list.map((h) => imageNameOf(h, image)).find(Boolean);

/** The Runtime image field's help for a new model on this hardware, whose current value is `image`. */
export const runtimeImageHelp = (hardware: ModelHardware | undefined, image: string) =>
  hardware?.image
    ? imageNameOf(hardware, image)
      ? `Set by ${hardware.label}: ${hardware.imageName}. Replace it to use another vLLM image.`
      : 'Set by the selected hardware. Replace it to use another vLLM image.'
    : mayUseDefaultImage(hardware?.accelerator)
      ? DEFAULT_IMAGE_HELP
      : 'Enter a vLLM image for this hardware.';

/** The hardware's environment variables, as the model's container lists them. */
export const hardwareEnv = (hardware: ModelHardware | undefined): EnvVar[] =>
  Object.entries(hardware?.env ?? {}).map(([name, value]) => ({ name, value }));

const acceleratorText = ({ resource, count }: AcceleratorRequest) => {
  const one = count === '1';
  const noun = isGPU(resource) ? (one ? 'GPU' : 'GPUs') : one ? 'accelerator' : 'accelerators';
  return `${count} ${noun} (${resource})`;
};

/**
 * What a deployed model requests per replica besides CPU and memory, in words: "1 GPU
 * (nvidia.com/gpu)", or "None (CPU only)".
 */
export const acceleratorsText = (model: Pick<ModelView, 'acceleratorRequests'>) =>
  model.acceleratorRequests.map(acceleratorText).join(', ') || 'None (CPU only)';

const QUANTITY_SUFFIX: Record<string, number> = {
  '': 1,
  m: 1e-3,
  k: 1e3,
  M: 1e6,
  G: 1e9,
  T: 1e12,
  P: 1e15,
  E: 1e18,
  Ki: 2 ** 10,
  Mi: 2 ** 20,
  Gi: 2 ** 30,
  Ti: 2 ** 40,
  Pi: 2 ** 50,
  Ei: 2 ** 60,
};

/**
 * A stored accelerator count as the wizard's whole-number field shows it ("3000m" and "3" are both
 * "3"); undefined for a quantity that isn't a whole number the field can hold.
 */
export const wholeCount = (quantity: string): string | undefined => {
  const match = /^\+?(\d+(?:\.\d*)?|\.\d+)(?:[eE]([-+]?\d+)|(m|k|M|G|T|P|E|Ki|Mi|Gi|Ti|Pi|Ei))?$/.exec(quantity.trim());
  if (!match) return undefined;
  const [, number, exponent, suffix = ''] = match;
  const value = Number(number) * (exponent !== undefined ? 10 ** Number(exponent) : QUANTITY_SUFFIX[suffix]);
  // Rounding keeps 3000m (3000 * 0.001) a whole 3.
  const rounded = Math.round(value);
  return Number.isSafeInteger(rounded) && Math.abs(value - rounded) < 1e-9 ? String(rounded) : undefined;
};

/**
 * The first entry of the list a deployed model runs on, which its edit starts on: for an entry with
 * an accelerator, a model that requests that accelerator and no other; for one without, a model
 * that requests none and has each of the entry's environment variables with its value. The image is
 * not compared, so a model with an image of its own still matches its hardware. Undefined when no
 * entry matches, and for a model with presets, whose image and environment come partly from them.
 * Matching selects the entry only; the model keeps its own image, environment and resources.
 */
export const matchingHardware = (
  model: Pick<ModelView, 'acceleratorRequests' | 'env' | 'baseRefs'>,
  list: readonly ModelHardware[],
): ModelHardware | undefined => {
  if (model.baseRefs.length > 0) return undefined;
  const resources = model.acceleratorRequests.map((r) => r.resource);
  return list.find((h) =>
    h.accelerator
      ? resources.length === 1 && resources[0] === h.accelerator
      : resources.length === 0 &&
        Object.entries(h.env ?? {}).every(([name, value]) =>
          model.env.some((v) => v.name === name && v.value === value),
        ),
  );
};

/**
 * A deployed model's environment with this hardware selected in the edit wizard: the variables any
 * entry of the list sets give way to this entry's, and every other variable stays in its place. The
 * runtime arguments are left out; the wizard adds them back.
 */
export const envWithHardware = (
  env: readonly EnvVar[],
  hardware: ModelHardware,
  list: readonly ModelHardware[],
): EnvVar[] => {
  const hardwareNames = new Set(list.flatMap((h) => Object.keys(h.env ?? {})));
  return [
    ...env
      .filter((v) => v.name !== RUNTIME_ARGS_ENV && !hardwareNames.has(v.name))
      .map(({ name, value }) => ({ name, value })),
    ...hardwareEnv(hardware),
  ];
};

/**
 * The hardware a new model starts on: the first entry of the list, except that a grid whose
 * model-serving members (AI Grid enabled, Inference or Ingress and inference role) all report no
 * GPUs starts on the first entry without an accelerator, so a CPU-only grid is not offered an
 * NVIDIA GPU that never becomes ready. A member whose GPU count is unknown (undefined) counts as
 * having GPUs. Known limit: gpuCapacity counts nvidia.com/gpu only, so an AMD-only grid reads as
 * GPU-less and starts on CPU.
 */
export const defaultHardware = (
  list: readonly ModelHardware[],
  clusters: readonly ClusterView[] | undefined,
): ModelHardware | undefined => {
  const serving = (clusters ?? []).filter((c) => {
    const role = roleOf(c.labels)?.value;
    return c.aiGridEnabled && (role === 'inference' || role === 'combined');
  });
  const cpuOnly = serving.length > 0 && serving.every((c) => c.gpuCapacity === 0);
  return (cpuOnly && list.find((h) => !h.accelerator)) || list[0];
};
