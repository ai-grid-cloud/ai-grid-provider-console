package fakebackend

import (
	"encoding/json"
	"fmt"
	"sort"
	"time"

	"google.golang.org/protobuf/encoding/protojson"
	"google.golang.org/protobuf/proto"
	"google.golang.org/protobuf/types/known/timestamppb"

	aigridv1 "github.com/ai-grid-cloud/ai-grid-provider-console/bff/gen/ai_grid/v1"
)

// Scenario events. Each one is a transition a hub controller drives, with the
// condition, taint and label changes mock/research/acm.md section 1 lists for
// it ("What the fake backend must simulate", items 2, 3 and 5).
const (
	// EventJoined: the klusterlet registered and its certificate was signed.
	// Adds ManagedClusterJoined, Available and ClockSynced True, publishes
	// what the agent reports (claims, capacity, allocatable, version), lets
	// autodetect replace the `auto-detect` labels and removes the
	// `unreachable` taint.
	EventJoined = "joined"
	// EventImported: the `<cluster>-klusterlet` ManifestWork is Available;
	// ImportSucceeded becomes True/ManagedClusterImported.
	EventImported = "imported"
	// EventAddonsAvailable: the add-on agents report; the
	// `feature.open-cluster-management.io/addon-*` labels appear as
	// `available`. On a hub they come one by one over about a minute; the
	// fake sets the whole list at once (schedule several events with
	// different `addons` lists to spread them).
	EventAddonsAvailable = "addons-available"
	// EventLeaseLost: 5 x leaseDurationSeconds without a lease renewal.
	// Available Unknown/ManagedClusterLeaseUpdateStopped, taint `unreachable`
	// with timeAdded, addon labels `unreachable`.
	EventLeaseLost = "lease-lost"
	// EventLeaseRecovered: the agent renews again; reverses EventLeaseLost
	// with a new lastTransitionTime.
	EventLeaseRecovered = "lease-recovered"
	// EventAPIDown: the agent is alive but the managed API server answers
	// errors. Available False/ManagedClusterKubeAPIServerUnavailable, taint
	// `unavailable`, addon labels `unhealthy`.
	EventAPIDown = "api-down"
	// EventAPIUp: reverses EventAPIDown.
	EventAPIUp = "api-up"
	// EventDetaching: deletion requested; deletionTimestamp is set,
	// ImportSucceeded becomes False/ManagedClusterDetaching and the gc
	// controller adds Deleting/ResourceRemaining while the finalizers drain
	// (its message text is not verified by the research, so it is empty).
	EventDetaching = "detaching"
	// EventDetached: the finalizers are gone; the object disappears.
	EventDetached = "detached"
)

// ScenarioEvent is one timed transition from scenarios.json. `at` is relative
// to the fake's start and is divided by the settings' `speed`.
type ScenarioEvent struct {
	// Cluster the event applies to.
	Cluster string `json:"cluster"`
	// At is when the event fires, relative to start, for example "20s".
	At Duration `json:"at"`
	// Event is one of the Event* constants.
	Event string `json:"event"`
	// Spoke, for `joined`: what the agent reports once it joins, as a
	// protojson ManagedClusterStatus (`kubernetesVersion`, `capacity`,
	// `allocatable`, `clusterClaims`). Labels are derived from the claims
	// like the autodetect controller does.
	Spoke json.RawMessage `json:"spoke,omitempty"`
	// Addons, for `addons-available`: add-on names without the label prefix.
	// Defaults to the add-ons of a plain ACM import.
	Addons []string `json:"addons,omitempty"`
	// StatusCode and Detail, for `api-down`: fill the agent's message
	// "The kube-apiserver is not ok, status code: %d, %v". Default 503.
	StatusCode int    `json:"statusCode,omitempty"`
	Detail     string `json:"detail,omitempty"`
}

// scenario is a parsed event waiting to fire.
type scenario struct {
	ScenarioEvent
	spoke   *aigridv1.ManagedClusterStatus
	applied bool
}

var knownEvents = map[string]bool{
	EventJoined: true, EventImported: true, EventAddonsAvailable: true, EventLeaseLost: true,
	EventLeaseRecovered: true, EventAPIDown: true, EventAPIUp: true, EventDetaching: true, EventDetached: true,
}

// parseScenarios validates the events and orders them by time.
func parseScenarios(events []ScenarioEvent, clusters map[string]*aigridv1.ManagedCluster) ([]*scenario, error) {
	out := make([]*scenario, 0, len(events))
	for i, ev := range events {
		if !knownEvents[ev.Event] {
			return nil, fmt.Errorf("scenario %d: unknown event %q", i, ev.Event)
		}
		if _, ok := clusters[ev.Cluster]; !ok {
			return nil, fmt.Errorf("scenario %d: cluster %q is not in the fixtures", i, ev.Cluster)
		}
		sc := &scenario{ScenarioEvent: ev}
		if len(ev.Spoke) > 0 {
			sc.spoke = &aigridv1.ManagedClusterStatus{}
			if err := protojson.Unmarshal(ev.Spoke, sc.spoke); err != nil {
				return nil, fmt.Errorf("scenario %d: spoke: %w", i, err)
			}
		}
		out = append(out, sc)
	}
	sort.SliceStable(out, func(i, j int) bool { return out[i].At.Duration() < out[j].At.Duration() })
	return out, nil
}

// advance fires every due event. It is called under s.mu by every read and
// write, so transitions are evaluated lazily from the clock and no goroutine
// is needed; the result is the same as a controller that ran in between.
func (s *Server) advance() {
	if len(s.scenarios) == 0 {
		return
	}
	now := s.clock()
	elapsed := time.Duration(float64(now.Sub(s.start)) * s.speed)
	for _, sc := range s.scenarios {
		if sc.applied || sc.At.Duration() > elapsed {
			continue
		}
		sc.applied = true
		c, ok := s.clusters[sc.Cluster]
		if !ok {
			continue // detached earlier
		}
		// The event happened at its scheduled wall-clock time, not when it
		// was noticed, so lastTransitionTime and timeAdded are consistent.
		at := s.start.Add(time.Duration(float64(sc.At.Duration()) / s.speed))
		s.applyEvent(c, sc, at)
		s.logger.Info("scenario", "cluster", sc.Cluster, "event", sc.Event, "at", sc.At.Duration())
	}
}

func (s *Server) applyEvent(c *aigridv1.ManagedCluster, sc *scenario, now time.Time) {
	switch sc.Event {
	case EventJoined:
		if sc.spoke != nil {
			if c.Status == nil {
				c.Status = &aigridv1.ManagedClusterStatus{}
			}
			// A copy, so the stored object never aliases the scenario.
			spoke := proto.Clone(sc.spoke).(*aigridv1.ManagedClusterStatus)
			c.Status.KubernetesVersion = spoke.GetKubernetesVersion()
			c.Status.Capacity = spoke.GetCapacity()
			c.Status.Allocatable = spoke.GetAllocatable()
			c.Status.ClusterClaims = spoke.GetClusterClaims()
			sortClaims(c)
		}
		setCondition(c, now, CondJoined, aigridv1.ConditionStatus_CONDITION_STATUS_TRUE, ReasonJoined, MessageJoined)
		setCondition(c, now, CondAvailable, aigridv1.ConditionStatus_CONDITION_STATUS_TRUE, ReasonAvailable, MessageAvailable)
		setCondition(c, now, CondClockSynced, aigridv1.ConditionStatus_CONDITION_STATUS_TRUE, ReasonClockSynced, MessageClockSynced)
		autodetectLabels(c)
		removeTaint(c, TaintUnreachable)
	case EventImported:
		setCondition(c, now, CondImportSucceeded, aigridv1.ConditionStatus_CONDITION_STATUS_TRUE, ReasonImported, MessageImported)
	case EventAddonsAvailable:
		addons := sc.Addons
		if len(addons) == 0 {
			addons = defaultAddons
		}
		if c.Labels == nil {
			c.Labels = map[string]string{}
		}
		for _, a := range addons {
			c.Labels[LabelAddonPrefix+a] = AddonAvailable
		}
	case EventLeaseLost:
		setCondition(c, now, CondAvailable, aigridv1.ConditionStatus_CONDITION_STATUS_UNSPECIFIED, ReasonLeaseStopped, MessageLeaseStopped)
		addTaint(c, now, TaintUnreachable)
		setAddonLabels(c, AddonUnreachable)
	case EventLeaseRecovered, EventAPIUp:
		setCondition(c, now, CondAvailable, aigridv1.ConditionStatus_CONDITION_STATUS_TRUE, ReasonAvailable, MessageAvailable)
		removeTaint(c, TaintUnreachable)
		removeTaint(c, TaintUnavailable)
		setAddonLabels(c, AddonAvailable)
	case EventAPIDown:
		code := sc.StatusCode
		if code == 0 {
			code = 503
		}
		detail := sc.Detail
		if detail == "" {
			detail = "the server is currently unable to handle the request"
		}
		setCondition(c, now, CondAvailable, aigridv1.ConditionStatus_CONDITION_STATUS_FALSE, ReasonAPIServerUnavail, fmt.Sprintf(MessageAPIServerUnavailFm, code, detail))
		addTaint(c, now, TaintUnavailable)
		setAddonLabels(c, AddonUnhealthy)
	case EventDetaching:
		c.DeletionTimestamp = timestamppb.New(now)
		setCondition(c, now, CondImportSucceeded, aigridv1.ConditionStatus_CONDITION_STATUS_FALSE, ReasonDetaching, MessageDetaching)
		setCondition(c, now, CondDeleting, aigridv1.ConditionStatus_CONDITION_STATUS_TRUE, ReasonResourceRemaining, "")
	case EventDetached:
		delete(s.clusters, c.GetName())
		return
	}
	s.bumpResourceVersion(c)
}
