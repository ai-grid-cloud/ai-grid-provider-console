package config

import (
	"encoding/json"
	"errors"
	"fmt"
	"io"
	"regexp"
	"strings"
	"unicode"
)

// ModelHardware is one choice of the Deploy model wizard's Hardware field: the
// image, environment and starting resources a new model on that hardware gets.
// A provider admin lists them in the chart's console.models.hardware, which
// reaches the BFF as MODEL_HARDWARE (JSON); GET /api/v1/config serves them.
// charts/ai-grid-provider-console/values.schema.json checks the same rules as
// validate.
type ModelHardware struct {
	// ID is a DNS label, unique in the list.
	ID string `json:"id"`
	// Label is what the wizard shows, in sentence case.
	Label string `json:"label"`
	// Description is one sentence under the label.
	Description string `json:"description,omitempty"`
	// Accelerator is the extended resource the model requests per accelerator,
	// such as nvidia.com/gpu or amd.com/gpu. Empty: CPU only.
	Accelerator string `json:"accelerator,omitempty"`
	// Image is the runtime image a new model gets. Empty: the cluster's default
	// vLLM image, which is for NVIDIA GPUs.
	Image string `json:"image,omitempty"`
	// ImageName is what the wizard shows for Image, such as "vLLM CPU 0.18.0
	// (OpenShift AI 3.6)", where the digest alone says nothing; Image still is
	// what a model gets. Only with an Image; no leading or trailing whitespace.
	ImageName string `json:"imageName,omitempty"`
	// Env is added to the model's main container.
	Env map[string]string `json:"env,omitempty"`
	// Defaults are the resources the wizard starts from.
	Defaults *HardwareDefaults `json:"defaults,omitempty"`
}

// HardwareDefaults are the resources the wizard fills in for a hardware choice.
type HardwareDefaults struct {
	// Accelerators is the number of Accelerator to request; only with one.
	Accelerators *int   `json:"accelerators,omitempty"`
	CPU          string `json:"cpu,omitempty"`
	Memory       string `json:"memory,omitempty"`
}

// MaxAccelerators is the most accelerators the wizard requests for one replica.
const MaxAccelerators = 64

// runtimeArgsEnv is the variable the wizard writes the model's additional
// runtime arguments to (frontend/src/pages/models/fields/runtimeArgs.ts), so a
// hardware choice can't set it.
const runtimeArgsEnv = "VLLM_ADDITIONAL_ARGS"

// The rules values.schema.json writes as patterns. CPU and memory take the
// forms the wizard accepts (frontend/src/validation/index.ts, createModelSchema),
// a subset of Kubernetes quantities, so the wizard never starts from a default
// it refuses.
var (
	hardwareIDPattern   = regexp.MustCompile(`^[a-z0-9]([-a-z0-9]{0,61}[a-z0-9])?$`)
	dnsLabelPattern     = regexp.MustCompile(`^[a-z0-9]([-a-z0-9]*[a-z0-9])?$`)
	resourceNamePattern = regexp.MustCompile(`^[A-Za-z0-9]([-A-Za-z0-9_.]*[A-Za-z0-9])?$`)
	envNamePattern      = regexp.MustCompile(`^[-._a-zA-Z][-._a-zA-Z0-9]*$`)
	cpuPattern          = regexp.MustCompile(`^([1-9][0-9]*|0\.[0-9]*[1-9][0-9]*|[1-9][0-9]*\.[0-9]+|[1-9][0-9]*m)$`)
	memoryPattern       = regexp.MustCompile(`^[1-9][0-9]*(Mi|Gi|Ti)$`)
)

// cpuImage is the vLLM CPU image of OpenShift AI 3.6: kserve-llm-d-cpu in
// config/overlays/odh/params.env (version 0.18.0+rhaiv.11) on
// red-hat-data-services/kserve rhoai-3.6 at 71b7da3. When you bump the digest,
// bump cpuImageName to the new version, here and in the chart's values.yaml.
const cpuImage = "registry.redhat.io/rhaii/vllm-cpu-rhel9@sha256:0ec0f5ff9a5ff263f58db0cfb19e3d7eef24b94c2d8629fe5145f5a8747e28c9"

// cpuImageName is what the wizard shows for cpuImage: its version, as above.
const cpuImageName = "vLLM CPU 0.18.0 (OpenShift AI 3.6)"

// DefaultModelHardware is the list the console offers when MODEL_HARDWARE is
// empty or unset, as in a local run: a copy of the chart's default
// console.models.hardware, where the defaults live, which hack/check-chart.sh
// keeps equal to this list through mock/examples/get-config.json. NVIDIA GPU
// sets no image: with no image and no presets
// (spec.base_refs), KServe runs its default preset's vLLM image, which is for
// NVIDIA GPUs. CPU only copies OpenShift AI 3.6's CPU preset
// (config/overlays/odh/accelerators/cpu-config-llm-template.yaml on
// red-hat-data-services/kserve rhoai-3.6 at 71b7da3): its image and its
// VLLM_CPU_KVCACHE_SPACE and OMP_NUM_THREADS. The preset also sets the node
// selector kubernetes.io/arch: amd64, which the backend's Model API has no
// field for, so it is left out.
func DefaultModelHardware() []ModelHardware {
	one := 1
	return []ModelHardware{
		{
			ID:          "nvidia-gpu",
			Label:       "NVIDIA GPU",
			Description: "For clusters with NVIDIA GPUs.",
			Accelerator: "nvidia.com/gpu",
			Defaults:    &HardwareDefaults{Accelerators: &one, CPU: "2", Memory: "16Gi"},
		},
		{
			ID:          "cpu",
			Label:       "CPU only",
			Description: "For x86_64 clusters without GPUs.",
			Image:       cpuImage,
			ImageName:   cpuImageName,
			Env:         map[string]string{"VLLM_CPU_KVCACHE_SPACE": "4", "OMP_NUM_THREADS": "4"},
			Defaults:    &HardwareDefaults{CPU: "4", Memory: "8Gi"},
		},
	}
}

// ParseModelHardware reads MODEL_HARDWARE: a JSON list of ModelHardware, with
// no unknown field. Empty, or an empty list, is DefaultModelHardware.
func ParseModelHardware(raw string) ([]ModelHardware, error) {
	if strings.TrimSpace(raw) == "" {
		return DefaultModelHardware(), nil
	}
	dec := json.NewDecoder(strings.NewReader(raw))
	dec.DisallowUnknownFields()
	var list []ModelHardware
	if err := dec.Decode(&list); err != nil {
		return nil, fmt.Errorf("model-hardware is not a JSON list of hardware: %w", err)
	}
	if _, err := dec.Token(); !errors.Is(err, io.EOF) {
		return nil, errors.New("model-hardware is not a JSON list of hardware: unexpected data after the list")
	}
	if len(list) == 0 {
		return DefaultModelHardware(), nil
	}
	seen := map[string]bool{}
	var errs []error
	for i, hw := range list {
		name := fmt.Sprintf("model-hardware entry %d", i+1)
		if hw.ID != "" {
			name += fmt.Sprintf(" (%s)", hw.ID)
		}
		for _, problem := range hw.problems() {
			errs = append(errs, fmt.Errorf("%s: %s", name, problem))
		}
		if hw.ID != "" && seen[hw.ID] {
			errs = append(errs, fmt.Errorf("%s: id %q is used by an earlier entry", name, hw.ID))
		}
		seen[hw.ID] = true
	}
	if err := errors.Join(errs...); err != nil {
		return nil, err
	}
	return list, nil
}

// problems lists what is wrong with one entry, in the words of the rule it breaks.
func (hw ModelHardware) problems() []string {
	var out []string
	if !hardwareIDPattern.MatchString(hw.ID) {
		out = append(out, fmt.Sprintf("id %q must be a DNS label: up to 63 lowercase letters, digits and hyphens, starting and ending with a letter or digit", hw.ID))
	}
	if strings.TrimSpace(hw.Label) == "" {
		out = append(out, "label must not be empty")
	}
	if hw.Accelerator != "" && !isExtendedResourceName(hw.Accelerator) {
		out = append(out, fmt.Sprintf("accelerator %q must be an extended resource name: a domain outside kubernetes.io, a slash and a name, such as nvidia.com/gpu", hw.Accelerator))
	}
	if strings.ContainsFunc(hw.Image, unicode.IsSpace) {
		out = append(out, fmt.Sprintf("image %q must not contain whitespace", hw.Image))
	}
	if hw.ImageName != "" && hw.Image == "" {
		out = append(out, "imageName needs an image")
	}
	if hw.ImageName != strings.TrimSpace(hw.ImageName) {
		out = append(out, fmt.Sprintf("imageName %q must not start or end with whitespace", hw.ImageName))
	}
	for name := range hw.Env {
		switch {
		case !envNamePattern.MatchString(name):
			out = append(out, fmt.Sprintf("env name %q must be letters, digits, '_', '-' and '.', not starting with a digit", name))
		case name == runtimeArgsEnv:
			out = append(out, fmt.Sprintf("env must not set %s: the wizard's additional runtime arguments field writes it", runtimeArgsEnv))
		}
	}
	if d := hw.Defaults; d != nil {
		if d.Accelerators != nil {
			switch {
			case hw.Accelerator == "":
				out = append(out, "defaults.accelerators needs an accelerator")
			case *d.Accelerators < 1 || *d.Accelerators > MaxAccelerators:
				out = append(out, fmt.Sprintf("defaults.accelerators must be from 1 to %d", MaxAccelerators))
			}
		}
		if d.CPU != "" && !cpuPattern.MatchString(d.CPU) {
			out = append(out, fmt.Sprintf("defaults.cpu %q must be positive cores or millicores, such as 2 or 500m", d.CPU))
		}
		if d.Memory != "" && !memoryPattern.MatchString(d.Memory) {
			out = append(out, fmt.Sprintf("defaults.memory %q must be whole Mi, Gi or Ti, such as 16Gi", d.Memory))
		}
	}
	return out
}

// isExtendedResourceName is Kubernetes' rule for an extended resource name
// (IsExtendedResourceName in k8s.io/kubernetes pkg/apis/core/helper/helpers.go,
// with IsQualifiedName in k8s.io/apimachinery pkg/util/validation): a prefix
// that is a DNS subdomain, a slash, and a name of at most 63 characters; not a
// native resource, which is any name containing "kubernetes.io/" (so
// kubernetes.io/gpu, gpu.kubernetes.io/x and examplekubernetes.io/gpu alike);
// not starting with "requests."; and "requests." followed by it a qualified
// name, which keeps the prefix to 244 characters. It is stricter than
// Kubernetes in one way: each label of the prefix is at most 63 characters, as
// in a DNS name.
func isExtendedResourceName(name string) bool {
	prefix, rest, ok := strings.Cut(name, "/")
	switch {
	case !ok, strings.Contains(rest, "/"), strings.HasPrefix(name, "requests."),
		strings.Contains(name, "kubernetes.io/"),
		len(rest) > 63, !resourceNamePattern.MatchString(rest),
		len("requests.")+len(prefix) > 253:
		return false
	}
	for _, label := range strings.Split(prefix, ".") {
		if len(label) > 63 || !dnsLabelPattern.MatchString(label) {
			return false
		}
	}
	return true
}
