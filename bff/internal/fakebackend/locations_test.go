package fakebackend

import (
	"context"
	"slices"
	"testing"
	"time"

	"google.golang.org/grpc/codes"
	"google.golang.org/grpc/status"

	aigridv1 "github.com/ai-grid-cloud/ai-grid-provider-console/bff/gen/ai_grid/v1"

	"github.com/ai-grid-cloud/ai-grid-provider-console/bff/internal/api"
)

// gridMember is a ready cluster that is an AI Grid member at location.
func gridMember(name, location string) *aigridv1.ManagedCluster {
	c := readyCluster(name)
	c.Labels[LabelAIGridEnabled] = "true"
	c.Labels[LabelAIGridProvisioned] = "true"
	c.Labels[LabelLocation] = location
	return c
}

// TestListLocationsOnScenarioState: the PoC's eligibleLocations over the
// clusters as ListManagedClusters reads them: members, provisioned and
// Available, unique and sorted; a cluster the scenario takes offline drops
// out.
func TestListLocationsOnScenarioState(t *testing.T) {
	notProvisioned := gridMember("berlin-1", "berlin")
	notProvisioned.Labels[LabelAIGridProvisioned] = "false"
	notMember := gridMember("oslo-1", "oslo")
	delete(notMember.Labels, LabelAIGridEnabled)
	noLocation := gridMember("lyon-1", "")
	s := newServer(t, &Fixtures{
		Clusters: []*aigridv1.ManagedCluster{gridMember("paris-1", "paris"), gridMember("paris-2", "paris"), gridMember("madrid-1", "madrid"),
			notProvisioned, notMember, noLocation},
		Scenarios: []ScenarioEvent{{Cluster: "madrid-1", At: Duration{10 * time.Second}, Event: EventLeaseLost}},
	})
	start := time.Date(2026, 10, 16, 9, 0, 0, 0, time.UTC)
	now := start
	s.SetClock(func() time.Time { return now })
	list := func() []string {
		t.Helper()
		resp, err := s.ListLocations(authed(context.Background()), &aigridv1.ListLocationsRequest{})
		if err != nil {
			t.Fatal(err)
		}
		return resp.GetLocations()
	}
	if got := list(); !slices.Equal(got, []string{"madrid", "paris"}) {
		t.Fatalf("locations %v", got)
	}
	now = start.Add(10 * time.Second)
	if got := list(); !slices.Equal(got, []string{"paris"}) {
		t.Fatalf("after madrid lost its lease: %v", got)
	}
	if _, err := s.ListLocations(context.Background(), &aigridv1.ListLocationsRequest{}); status.Code(err) != codes.Unauthenticated {
		t.Fatalf("anonymous: %v", err)
	}
}

// TestListLocationsFromTheFixtures: under PR 12's fixtures only Paris is an
// Available, provisioned member at start (Madrid's lease recovers at 300s,
// Ashburn isn't provisioned).
func TestListLocationsFromTheFixtures(t *testing.T) {
	s := newRepoServer(t)
	resp, err := s.ListLocations(authed(context.Background()), &aigridv1.ListLocationsRequest{})
	if err != nil || !slices.Equal(resp.GetLocations(), []string{"paris"}) {
		t.Fatalf("locations %v %v", resp, err)
	}
}

// TestConsoleLabelsMatchTheBFF: the fake and the BFF name the same labels.
func TestConsoleLabelsMatchTheBFF(t *testing.T) {
	for fake, bff := range map[string]string{
		LabelAIGridEnabled: api.LabelEnabled, LabelAIGridProvisioned: api.LabelProvisioned, LabelLocation: api.LabelLocation,
		LabelAIGridSite: api.LabelSite, LabelAIGridRegion: api.LabelRegion,
	} {
		if fake != bff {
			t.Errorf("fake label %q, BFF label %q", fake, bff)
		}
	}
}

// TestPlacementReportsLocations (P8): a placed model's status names the
// `location` labels of the clusters the placement decided on, unique and
// sorted; a decided cluster without one adds nothing, and a model without a
// placement has none.
func TestPlacementReportsLocations(t *testing.T) {
	located := func(name, location string) *aigridv1.ManagedCluster {
		c := enrolled(name)
		if location != "" {
			c.Labels[LabelLocation] = location
		}
		return c
	}
	s, _ := modelServer(t, &Fixtures{Clusters: []*aigridv1.ManagedCluster{
		located("site-a", "paris"), located("site-b", "madrid"), located("site-c", "paris"), located("site-d", ""),
	}})
	placed := createModel(t, s, placedModel("placed", nil))
	if got := placed.GetStatus().GetPlacement().GetLocations(); !slices.Equal(got, []string{"madrid", "paris"}) {
		t.Errorf("placed model locations %v", got)
	}
	if got := getModel(t, s, "placed").GetStatus().GetPlacement().GetLocations(); !slices.Equal(got, []string{"madrid", "paris"}) {
		t.Errorf("read back %v", got)
	}
	if got := createModel(t, s, hubModel("hub")).GetStatus().GetPlacement(); got != nil {
		t.Errorf("hub model placement %v", got)
	}
}
