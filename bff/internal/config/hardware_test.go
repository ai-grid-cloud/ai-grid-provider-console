package config

import (
	"reflect"
	"strings"
	"testing"
)

func TestParseModelHardwareDefault(t *testing.T) {
	t.Parallel()
	hub := "--hub-api-url=https://hub.example"
	for _, env := range []map[string]string{nil, {"MODEL_HARDWARE": ""}, {"MODEL_HARDWARE": " \n"}, {"MODEL_HARDWARE": "[]"}} {
		cfg, err := Parse([]string{hub}, lookup(env))
		if err != nil {
			t.Fatalf("MODEL_HARDWARE=%q: %v", env["MODEL_HARDWARE"], err)
		}
		if !reflect.DeepEqual(cfg.ModelHardware, DefaultModelHardware()) {
			t.Fatalf("MODEL_HARDWARE=%q: %+v, want the built-in list", env["MODEL_HARDWARE"], cfg.ModelHardware)
		}
	}
	list := DefaultModelHardware()
	if len(list) != 2 {
		t.Fatalf("built-in list: %+v", list)
	}
	// NVIDIA GPU first, the wizard's default: no image, so the cluster's default vLLM image runs.
	gpu, cpu := list[0], list[1]
	if gpu.ID != "nvidia-gpu" || gpu.Label != "NVIDIA GPU" || gpu.Accelerator != "nvidia.com/gpu" || gpu.Image != "" || len(gpu.Env) != 0 ||
		gpu.Defaults == nil || gpu.Defaults.Accelerators == nil || *gpu.Defaults.Accelerators != 1 || gpu.Defaults.CPU != "2" || gpu.Defaults.Memory != "16Gi" {
		t.Errorf("NVIDIA GPU: %+v %+v", gpu, gpu.Defaults)
	}
	// CPU only: OpenShift AI 3.6's CPU preset's image and environment, no accelerator.
	wantEnv := map[string]string{"VLLM_CPU_KVCACHE_SPACE": "4", "OMP_NUM_THREADS": "4"}
	if cpu.ID != "cpu" || cpu.Label != "CPU only" || cpu.Accelerator != "" ||
		cpu.Image != "registry.redhat.io/rhaii/vllm-cpu-rhel9@sha256:0ec0f5ff9a5ff263f58db0cfb19e3d7eef24b94c2d8629fe5145f5a8747e28c9" ||
		cpu.ImageName != "vLLM CPU 0.18.0 (OpenShift AI 3.6)" ||
		!reflect.DeepEqual(cpu.Env, wantEnv) || cpu.Defaults == nil || cpu.Defaults.Accelerators != nil || cpu.Defaults.CPU != "4" || cpu.Defaults.Memory != "8Gi" {
		t.Errorf("CPU only: %+v %+v", cpu, cpu.Defaults)
	}
	// The built-in list passes its own rules.
	for _, hw := range list {
		if problems := hw.problems(); len(problems) > 0 {
			t.Errorf("%s: %v", hw.ID, problems)
		}
	}
	// Each call is a list of its own: a caller changing one leaves the next alone.
	list[1].Env["OMP_NUM_THREADS"] = "64"
	if DefaultModelHardware()[1].Env["OMP_NUM_THREADS"] != "4" {
		t.Error("DefaultModelHardware shares its env map between calls")
	}
}

func TestParseModelHardwareList(t *testing.T) {
	t.Parallel()
	hub := "--hub-api-url=https://hub.example"
	amd := `[{"id":"amd-gpu","label":"AMD GPU","description":"For clusters with AMD Instinct GPUs.","accelerator":"amd.com/gpu",
		"image":"quay.io/example/vllm-rocm:1.0","imageName":"vLLM ROCm 1.0","env":{"VLLM_USE_TRITON_FLASH_ATTN":"0"},"defaults":{"accelerators":2,"cpu":"500m","memory":"32Gi"}},
		{"id":"cpu","label":"CPU only"}]`
	cfg, err := Parse([]string{hub}, lookup(map[string]string{"MODEL_HARDWARE": amd}))
	if err != nil {
		t.Fatal(err)
	}
	two := 2
	want := []ModelHardware{
		{
			ID: "amd-gpu", Label: "AMD GPU", Description: "For clusters with AMD Instinct GPUs.", Accelerator: "amd.com/gpu",
			Image: "quay.io/example/vllm-rocm:1.0", ImageName: "vLLM ROCm 1.0", Env: map[string]string{"VLLM_USE_TRITON_FLASH_ATTN": "0"},
			Defaults: &HardwareDefaults{Accelerators: &two, CPU: "500m", Memory: "32Gi"},
		},
		{ID: "cpu", Label: "CPU only"},
	}
	if !reflect.DeepEqual(cfg.ModelHardware, want) {
		t.Fatalf("got %+v, want %+v", cfg.ModelHardware, want)
	}
	// The flag wins over the variable, as every setting's does.
	cfg, err = Parse([]string{hub, `--model-hardware=[{"id":"one","label":"One"}]`}, lookup(map[string]string{"MODEL_HARDWARE": amd}))
	if err != nil || len(cfg.ModelHardware) != 1 || cfg.ModelHardware[0].ID != "one" {
		t.Fatalf("flag over env: %+v, %v", cfg.ModelHardware, err)
	}
}

// A list the chart's schema would refuse fails the BFF's start too, with an error naming the
// entry and the rule, so a hand-set MODEL_HARDWARE can't reach the wizard.
func TestParseModelHardwareRefuses(t *testing.T) {
	t.Parallel()
	hub := "--hub-api-url=https://hub.example"
	cases := []struct {
		name, value, want string
	}{
		{"not JSON", `nvidia`, "not a JSON list"},
		{"an object, not a list", `{"id":"cpu","label":"CPU"}`, "not a JSON list"},
		{"a second value", `[{"id":"cpu","label":"CPU"}] []`, "unexpected data after the list"},
		{"an unknown field", `[{"id":"cpu","label":"CPU","nodeSelector":{"kubernetes.io/arch":"amd64"}}]`, `unknown field "nodeSelector"`},
		{"a misspelled field", `[{"id":"gpu","label":"GPU","acelerator":"nvidia.com/gpu"}]`, `unknown field "acelerator"`},
		{"a misspelled default", `[{"id":"gpu","label":"GPU","defaults":{"memroy":"8Gi"}}]`, `unknown field "memroy"`},
		{"no id", `[{"label":"CPU"}]`, `entry 1: id "" must be a DNS label`},
		{"an id in capitals", `[{"id":"CPU","label":"CPU"}]`, `entry 1 (CPU): id "CPU" must be a DNS label`},
		{"an id ending in a hyphen", `[{"id":"cpu-","label":"CPU"}]`, "must be a DNS label"},
		{"an id of 64 characters", `[{"id":"` + strings.Repeat("a", 64) + `","label":"CPU"}]`, "must be a DNS label"},
		{"a duplicate id", `[{"id":"cpu","label":"CPU"},{"id":"cpu","label":"CPU again"}]`, `entry 2 (cpu): id "cpu" is used by an earlier entry`},
		{"no label", `[{"id":"cpu","label":" "}]`, "label must not be empty"},
		{"a label of Unicode spaces", "[{\"id\":\"cpu\",\"label\":\"\u00a0\u2003\"}]", "label must not be empty"},
		{"an image with a no-break space", "[{\"id\":\"cpu\",\"label\":\"CPU\",\"image\":\"quay.io/vllm\u00a0cpu:1\"}]", "must not contain whitespace"},
		{"an accelerator without a domain", `[{"id":"gpu","label":"GPU","accelerator":"gpu"}]`, `accelerator "gpu" must be an extended resource name`},
		{"an accelerator in kubernetes.io", `[{"id":"gpu","label":"GPU","accelerator":"kubernetes.io/gpu"}]`, `accelerator "kubernetes.io/gpu" must be an extended resource name`},
		{"an image with a space", `[{"id":"cpu","label":"CPU","image":"quay.io/vllm cpu:1"}]`, "must not contain whitespace"},
		{"an image with a tab", `[{"id":"cpu","label":"CPU","image":"quay.io/vllm\tcpu:1"}]`, "must not contain whitespace"},
		{"an image name without an image", `[{"id":"cpu","label":"CPU","imageName":"vLLM CPU"}]`, "imageName needs an image"},
		{"an image name with leading space", `[{"id":"cpu","label":"CPU","image":"quay.io/vllm:1","imageName":" vLLM CPU"}]`, "must not start or end with whitespace"},
		{"an image name with trailing space", `[{"id":"cpu","label":"CPU","image":"quay.io/vllm:1","imageName":"vLLM CPU\n"}]`, "must not start or end with whitespace"},
		{"an unknown field", `[{"id":"cpu","label":"CPU","imageLabel":"vLLM CPU"}]`, "not a JSON list"},
		{"a bad env name", `[{"id":"cpu","label":"CPU","env":{"1THREADS":"4"}}]`, `env name "1THREADS"`},
		{"the runtime arguments' env", `[{"id":"cpu","label":"CPU","env":{"VLLM_ADDITIONAL_ARGS":"--x"}}]`, "must not set VLLM_ADDITIONAL_ARGS"},
		{"accelerators without an accelerator", `[{"id":"cpu","label":"CPU","defaults":{"accelerators":1}}]`, "defaults.accelerators needs an accelerator"},
		{"no accelerators", `[{"id":"gpu","label":"GPU","accelerator":"nvidia.com/gpu","defaults":{"accelerators":0}}]`, "defaults.accelerators must be from 1 to 64"},
		{"65 accelerators", `[{"id":"gpu","label":"GPU","accelerator":"nvidia.com/gpu","defaults":{"accelerators":65}}]`, "defaults.accelerators must be from 1 to 64"},
		{"fractional accelerators", `[{"id":"gpu","label":"GPU","accelerator":"nvidia.com/gpu","defaults":{"accelerators":1.5}}]`, "not a JSON list"},
		{"a CPU in words", `[{"id":"cpu","label":"CPU","defaults":{"cpu":"2 cores"}}]`, `defaults.cpu "2 cores"`},
		{"no CPU", `[{"id":"cpu","label":"CPU","defaults":{"cpu":"0"}}]`, `defaults.cpu "0"`},
		{"memory in G", `[{"id":"cpu","label":"CPU","defaults":{"memory":"16G"}}]`, `defaults.memory "16G"`},
		{"a number for memory", `[{"id":"cpu","label":"CPU","defaults":{"memory":16}}]`, "not a JSON list"},
	}
	for _, tc := range cases {
		_, err := Parse([]string{hub}, lookup(map[string]string{"MODEL_HARDWARE": tc.value}))
		if err == nil || !strings.Contains(err.Error(), "model-hardware") || !strings.Contains(err.Error(), tc.want) {
			t.Errorf("%s: err = %v, want one naming model-hardware and %q", tc.name, err, tc.want)
		}
	}
	// Every problem is reported, not only the first.
	_, err := Parse([]string{hub}, lookup(map[string]string{"MODEL_HARDWARE": `[{"id":"A","label":"","image":"a b"}]`}))
	for _, want := range []string{"DNS label", "label must not be empty", "whitespace"} {
		if err == nil || !strings.Contains(err.Error(), want) {
			t.Errorf("three problems: %v, want %q among them", err, want)
		}
	}
}

// An accelerator is a Kubernetes extended resource name, which a model can request.
func TestHardwareAcceleratorNames(t *testing.T) {
	t.Parallel()
	label := strings.Repeat("a", 63)
	// 244 characters: "requests." and this prefix make 253.
	longest := strings.Join([]string{label, label, label, strings.Repeat("b", 52)}, ".")
	for _, name := range []string{
		"nvidia.com/gpu", "amd.com/gpu", "habana.ai/gaudi", "example.com/" + label, "nvidia.com/mig-1g.10gb",
		"example.com/GPU_x", label + ".example.com/gpu", longest + "/gpu", "kubernetes.io.example.com/gpu",
	} {
		if !isExtendedResourceName(name) {
			t.Errorf("%q refused", name)
		}
	}
	for _, name := range []string{
		"", "gpu", "/gpu", "nvidia.com/", "nvidia.com/gpu/x", "nvidia..com/gpu", ".nvidia.com/gpu", "nvidia.com./gpu",
		"Nvidia.com/gpu", "nvidia_com/gpu", "-nvidia.com/gpu", "nvidia.com/-gpu", "nvidia.com/gpu-", "nvidia.com/g pu",
		"example.com/" + label + "a", label + "a.example.com/gpu", longest + "b/gpu",
		"kubernetes.io/gpu", "gpu.kubernetes.io/x", "a.b.kubernetes.io/x", "examplekubernetes.io/gpu", "requests.nvidia.com/gpu",
	} {
		if isExtendedResourceName(name) {
			t.Errorf("%q accepted", name)
		}
	}
}

// The quantities the wizard accepts, and so the defaults the list may set.
func TestHardwareQuantities(t *testing.T) {
	t.Parallel()
	for _, cpu := range []string{"1", "2", "16", "500m", "0.5", "1.5"} {
		if !cpuPattern.MatchString(cpu) {
			t.Errorf("cpu %q refused", cpu)
		}
	}
	for _, cpu := range []string{"", "0", "0m", "-1", "2 ", "1e3", "2k", "m"} {
		if cpuPattern.MatchString(cpu) {
			t.Errorf("cpu %q accepted", cpu)
		}
	}
	for _, memory := range []string{"512Mi", "8Gi", "16Gi", "1Ti"} {
		if !memoryPattern.MatchString(memory) {
			t.Errorf("memory %q refused", memory)
		}
	}
	for _, memory := range []string{"", "0Gi", "16G", "16", "1.5Gi", "8gi", "16Ki"} {
		if memoryPattern.MatchString(memory) {
			t.Errorf("memory %q accepted", memory)
		}
	}
}
