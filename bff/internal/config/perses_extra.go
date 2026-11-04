package config

import (
	"encoding/json"
	"errors"
	"fmt"
	"io"
	"strings"
	"unicode"
)

// PersesExtraProject is a Perses project the Monitoring page reads besides PersesProject, but only
// the dashboards and datasources it names, such as ACM observability's in
// open-cluster-management-observability. Its dashboards are Monitoring tabs, after the main
// project's, in this order. A provider admin lists them in the chart's
// console.perses.extraDashboards, which reaches the BFF as PERSES_EXTRA_DASHBOARDS (JSON); GET
// /api/v1/config serves them. The relay (bff/internal/perses) checks the names when it starts.
type PersesExtraProject struct {
	Project     string                 `json:"project"`
	Dashboards  []PersesExtraDashboard `json:"dashboards"`
	Datasources []string               `json:"datasources"`
}

// PersesExtraDashboard is one dashboard of a PersesExtraProject.
type PersesExtraDashboard struct {
	Name string `json:"name"`
	// Title is the tab's title; empty: the dashboard's own display name.
	Title string `json:"title,omitempty"`
}

// MaxTabTitle is the longest tab title, in characters.
const MaxTabTitle = 80

// ParsePersesExtra reads PERSES_EXTRA_DASHBOARDS; empty is none.
func ParsePersesExtra(raw string) ([]PersesExtraProject, error) {
	if strings.TrimSpace(raw) == "" {
		return nil, nil
	}
	dec := json.NewDecoder(strings.NewReader(raw))
	dec.DisallowUnknownFields()
	var list []PersesExtraProject
	if err := dec.Decode(&list); err != nil {
		return nil, fmt.Errorf("perses-extra-dashboards is not a JSON list of projects: %w", err)
	}
	if _, err := dec.Token(); !errors.Is(err, io.EOF) {
		return nil, errors.New("perses-extra-dashboards is not a JSON list of projects: unexpected data after the list")
	}
	for _, p := range list {
		for _, d := range p.Dashboards {
			if d.Title == "" {
				continue
			}
			if strings.TrimSpace(d.Title) != d.Title || len([]rune(d.Title)) > MaxTabTitle || strings.IndexFunc(d.Title, unicode.IsControl) >= 0 {
				return nil, fmt.Errorf("perses-extra-dashboards: the title of %s/%s must be at most %d characters, with no control characters or surrounding spaces", p.Project, d.Name, MaxTabTitle)
			}
		}
	}
	return list, nil
}
