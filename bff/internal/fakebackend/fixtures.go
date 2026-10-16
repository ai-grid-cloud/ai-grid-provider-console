package fakebackend

import (
	"encoding/json"
	"errors"
	"fmt"
	"os"
	"path/filepath"
	"time"

	"google.golang.org/protobuf/encoding/protojson"

	aigridv1 "github.com/ai-grid-cloud/ai-grid-provider-console/bff/gen/ai_grid/v1"
)

// Fixtures is the content of a fixtures directory (mock/fixtures by default).
//
//	managedclusters.json  {"clusters": [ManagedCluster...]} in protojson
//	tenants.json          {"tenants": [Tenant...]} in protojson, or
//	                      {"unavailable": "<error text>"} to simulate a backend
//	                      whose Keycloak cannot be reached
//	access.json           who the fake hub treats as provider admin
//	settings.json         latency, scenario speed and other knobs
//	scenarios.json        {"events": [ScenarioEvent...]} timed transitions
//
// Proto messages are decoded with protojson so the files use the same field
// names (lowerCamelCase) that grpcurl and the real backend's JSON logs show.
type Fixtures struct {
	Clusters           []*aigridv1.ManagedCluster
	Tenants            []*aigridv1.Tenant
	TenantsUnavailable string
	Access             Access
	Latency            Duration
	// Speed multiplies the scenario clock; 2 fires a "20s" event after 10s.
	// Zero (not set) means 1.
	Speed     float64
	Scenarios []ScenarioEvent
}

// Access decides the fake hub's SelfSubjectAccessReview answers.
type Access struct {
	// DefaultAllowed is the answer for any token not listed below.
	DefaultAllowed bool `json:"defaultAllowed"`
	// DeniedTokens get allowed: false, like a user without the ClusterRole.
	DeniedTokens []string `json:"deniedTokens"`
	// RejectedTokens get 401, like an expired or revoked OpenShift token.
	RejectedTokens []string `json:"rejectedTokens"`
}

// Duration is a time.Duration that decodes from JSON strings like "80ms".
type Duration struct{ d time.Duration }

// Duration returns the wrapped value.
func (d Duration) Duration() time.Duration { return d.d }

// UnmarshalJSON accepts a Go duration string.
func (d *Duration) UnmarshalJSON(b []byte) error {
	var s string
	if err := json.Unmarshal(b, &s); err != nil {
		return err
	}
	v, err := time.ParseDuration(s)
	if err != nil {
		return fmt.Errorf("duration %q: %w", s, err)
	}
	d.d = v
	return nil
}

// Load reads a fixtures directory. Missing files are allowed and leave their
// part empty, so a directory with only managedclusters.json is valid. The
// directory itself must exist: a mistyped --fixtures path is a configuration
// error, not an empty backend.
func Load(dir string) (*Fixtures, error) {
	info, err := os.Stat(dir)
	if err != nil {
		return nil, fmt.Errorf("fixtures directory: %w", err)
	}
	if !info.IsDir() {
		return nil, fmt.Errorf("fixtures directory %s is not a directory", dir)
	}
	fx := &Fixtures{Access: Access{DefaultAllowed: true}}

	if raw, ok, err := readFile(filepath.Join(dir, "managedclusters.json")); err != nil {
		return nil, err
	} else if ok {
		var doc struct {
			Clusters []json.RawMessage `json:"clusters"`
		}
		if err := json.Unmarshal(raw, &doc); err != nil {
			return nil, fmt.Errorf("managedclusters.json: %w", err)
		}
		for i, m := range doc.Clusters {
			c := &aigridv1.ManagedCluster{}
			if err := protojson.Unmarshal(m, c); err != nil {
				return nil, fmt.Errorf("managedclusters.json cluster %d: %w", i, err)
			}
			fx.Clusters = append(fx.Clusters, c)
		}
	}

	if raw, ok, err := readFile(filepath.Join(dir, "tenants.json")); err != nil {
		return nil, err
	} else if ok {
		var doc struct {
			Tenants     []json.RawMessage `json:"tenants"`
			Unavailable string            `json:"unavailable"`
		}
		if err := json.Unmarshal(raw, &doc); err != nil {
			return nil, fmt.Errorf("tenants.json: %w", err)
		}
		if doc.Unavailable != "" && doc.Tenants != nil {
			return nil, errors.New("tenants.json: use either tenants or unavailable, not both")
		}
		fx.TenantsUnavailable = doc.Unavailable
		if doc.Tenants != nil {
			fx.Tenants = []*aigridv1.Tenant{}
		}
		for i, m := range doc.Tenants {
			t := &aigridv1.Tenant{}
			if err := protojson.Unmarshal(m, t); err != nil {
				return nil, fmt.Errorf("tenants.json tenant %d: %w", i, err)
			}
			fx.Tenants = append(fx.Tenants, t)
		}
	}

	if raw, ok, err := readFile(filepath.Join(dir, "access.json")); err != nil {
		return nil, err
	} else if ok {
		if err := json.Unmarshal(raw, &fx.Access); err != nil {
			return nil, fmt.Errorf("access.json: %w", err)
		}
	}

	if raw, ok, err := readFile(filepath.Join(dir, "settings.json")); err != nil {
		return nil, err
	} else if ok {
		var doc struct {
			Latency Duration `json:"latency"`
			Speed   *float64 `json:"speed"`
		}
		if err := json.Unmarshal(raw, &doc); err != nil {
			return nil, fmt.Errorf("settings.json: %w", err)
		}
		fx.Latency = doc.Latency
		if doc.Speed != nil {
			if *doc.Speed <= 0 {
				return nil, fmt.Errorf("settings.json: speed must be greater than zero, got %v", *doc.Speed)
			}
			fx.Speed = *doc.Speed
		}
	}

	if raw, ok, err := readFile(filepath.Join(dir, "scenarios.json")); err != nil {
		return nil, err
	} else if ok {
		var doc struct {
			Events []ScenarioEvent `json:"events"`
		}
		if err := json.Unmarshal(raw, &doc); err != nil {
			return nil, fmt.Errorf("scenarios.json: %w", err)
		}
		fx.Scenarios = doc.Events
	}
	return fx, nil
}

func readFile(path string) ([]byte, bool, error) {
	raw, err := os.ReadFile(path)
	if errors.Is(err, os.ErrNotExist) {
		return nil, false, nil
	}
	if err != nil {
		return nil, false, err
	}
	return raw, true, nil
}
