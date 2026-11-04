package config

import (
	"strings"
	"testing"
)

const acmExtra = `[{"project":"open-cluster-management-observability","dashboards":[{"name":"acm-clusters-overview","title":"Clusters overview"},{"name":"acm-alerts-by-cluster"}],"datasources":["rbac-query-proxy-datasource"]}]`

func TestParsePersesExtra(t *testing.T) {
	t.Parallel()
	env := map[string]string{"PERSES_URL": "https://perses.example.svc", "PERSES_PROJECT": "ai-grid", "PERSES_EXTRA_DASHBOARDS": acmExtra}
	cfg, err := Parse([]string{"--hub-api-url=https://hub.example:6443"}, lookup(env))
	if err != nil {
		t.Fatal(err)
	}
	if len(cfg.PersesExtra) != 1 {
		t.Fatalf("PersesExtra = %+v, want one project", cfg.PersesExtra)
	}
	p := cfg.PersesExtra[0]
	if p.Project != "open-cluster-management-observability" || len(p.Dashboards) != 2 || p.Dashboards[0].Title != "Clusters overview" || p.Dashboards[1].Title != "" || p.Datasources[0] != "rbac-query-proxy-datasource" {
		t.Fatalf("PersesExtra = %+v", p)
	}
}

func TestParsePersesExtraNone(t *testing.T) {
	t.Parallel()
	for _, raw := range []string{"", "  "} {
		list, err := ParsePersesExtra(raw)
		if err != nil || list != nil {
			t.Errorf("ParsePersesExtra(%q) = %v, %v; want none", raw, list, err)
		}
	}
}

func TestParsePersesExtraRefuses(t *testing.T) {
	t.Parallel()
	for name, raw := range map[string]string{
		"not JSON":       `open-cluster-management-observability`,
		"an object":      `{"project":"p"}`,
		"an unknown key": `[{"project":"p","dashboards":[{"name":"d"}],"datasources":["s"],"all":true}]`,
		"trailing data":  acmExtra + `[]`,
		"a long title":   `[{"project":"p","dashboards":[{"name":"d","title":"` + strings.Repeat("x", MaxTabTitle+1) + `"}],"datasources":["s"]}]`,
		"a padded title": `[{"project":"p","dashboards":[{"name":"d","title":" x"}],"datasources":["s"]}]`,
		"a control char": `[{"project":"p","dashboards":[{"name":"d","title":"a\nb"}],"datasources":["s"]}]`,
	} {
		if _, err := ParsePersesExtra(raw); err == nil {
			t.Errorf("%s: ParsePersesExtra accepted %s", name, raw)
		}
	}
}

func TestParsePersesExtraNeedsPerses(t *testing.T) {
	t.Parallel()
	_, err := Parse([]string{"--hub-api-url=https://hub.example:6443"}, lookup(map[string]string{"PERSES_EXTRA_DASHBOARDS": acmExtra}))
	if err == nil || !strings.Contains(err.Error(), "needs perses-url") {
		t.Fatalf("Parse() error = %v, want it to need perses-url", err)
	}
}
