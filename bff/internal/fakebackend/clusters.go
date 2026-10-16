package fakebackend

import (
	"context"
	"maps"
	"sort"
	"strings"

	"google.golang.org/grpc/codes"
	"google.golang.org/grpc/status"

	aigridv1 "github.com/ai-grid-cloud/ai-grid-provider-console/bff/gen/ai_grid/v1"
)

// Field-mask paths UpdateManagedCluster accepts (the mutable fields of the
// hub object a provider admin may patch). Anything else is InvalidArgument.
const (
	PathLabels           = "labels"
	PathAnnotations      = "annotations"
	PathHubAcceptsClient = "hub_accepts_client"
)

// notFound is the NotFound message shape from the conventions' error table
// (`object with identifier '<x>' not found`).
func notFound(name string) error {
	return status.Errorf(codes.NotFound, "object with identifier '%s' not found", name)
}

// ListManagedClusters implements ManagedClusters. Like a hub list, the result
// is sorted by name; `offset` and `limit` page it (omitted limit means all,
// zero means count only, negative is InvalidArgument). `filter` and `order`
// are drafted but not implemented here, so a non-empty value is
// InvalidArgument rather than silently ignored.
func (s *Server) ListManagedClusters(ctx context.Context, req *aigridv1.ListManagedClustersRequest) (*aigridv1.ListManagedClustersResponse, error) {
	if _, err := s.begin(ctx); err != nil {
		return nil, err
	}
	if req.GetFilter() != "" {
		return nil, status.Error(codes.InvalidArgument, "filter is not supported by this server yet")
	}
	if req.GetOrder() != "" {
		return nil, status.Error(codes.InvalidArgument, "order is not supported by this server yet")
	}
	if req.GetOffset() < 0 {
		return nil, status.Errorf(codes.InvalidArgument, "offset must not be negative, got %d", req.GetOffset())
	}
	if req.Limit != nil && req.GetLimit() < 0 {
		return nil, status.Errorf(codes.InvalidArgument, "limit must not be negative, got %d", req.GetLimit())
	}
	s.mu.Lock()
	defer s.mu.Unlock()
	s.advance()
	all := make([]*aigridv1.ManagedCluster, 0, len(s.clusters))
	for _, c := range s.clusters {
		all = append(all, withDerivedState(c))
	}
	sort.Slice(all, func(i, j int) bool { return all[i].GetName() < all[j].GetName() })
	total := len(all)
	offset := min(int(req.GetOffset()), total)
	page := all[offset:]
	if req.Limit != nil && int(req.GetLimit()) < len(page) {
		page = page[:req.GetLimit()]
	}
	return &aigridv1.ListManagedClustersResponse{Clusters: page, Size: int32(len(page)), Total: int32(total)}, nil
}

// GetManagedCluster implements ManagedClusters.
func (s *Server) GetManagedCluster(ctx context.Context, req *aigridv1.GetManagedClusterRequest) (*aigridv1.GetManagedClusterResponse, error) {
	if _, err := s.begin(ctx); err != nil {
		return nil, err
	}
	if req.GetName() == "" {
		return nil, status.Error(codes.InvalidArgument, "name is required")
	}
	s.mu.Lock()
	defer s.mu.Unlock()
	s.advance()
	c, ok := s.clusters[req.GetName()]
	if !ok {
		return nil, notFound(req.GetName())
	}
	return &aigridv1.GetManagedClusterResponse{Object: withDerivedState(c)}, nil
}

// UpdateManagedCluster implements ManagedClusters with the semantics of
// mock/research/backend-conventions.md section 5.3: the mask names whole
// fields of `object` (a map path replaces the map), `lock` compares
// `resource_version` and fails with Aborted, and every write bumps the
// version. Flipping `hub_accepts_client` makes the registration controller
// rewrite `HubAcceptedManagedCluster` as the hub would.
func (s *Server) UpdateManagedCluster(ctx context.Context, req *aigridv1.UpdateManagedClusterRequest) (*aigridv1.UpdateManagedClusterResponse, error) {
	token, err := s.begin(ctx)
	if err != nil {
		return nil, err
	}
	obj := req.GetObject()
	if obj.GetName() == "" {
		return nil, status.Error(codes.InvalidArgument, "object.name is required")
	}
	if err := s.authorizePatch(ctx, token, obj.GetName()); err != nil {
		return nil, err
	}
	paths := req.GetUpdateMask().GetPaths()
	if len(paths) == 0 {
		return nil, status.Errorf(codes.InvalidArgument, "update_mask must name at least one of %s", strings.Join([]string{PathLabels, PathAnnotations, PathHubAcceptsClient}, ", "))
	}
	for _, p := range paths {
		switch p {
		case PathLabels, PathAnnotations, PathHubAcceptsClient:
		default:
			return nil, status.Errorf(codes.InvalidArgument, "update_mask path %q is not supported; supported paths: %s", p, strings.Join([]string{PathLabels, PathAnnotations, PathHubAcceptsClient}, ", "))
		}
	}

	s.mu.Lock()
	defer s.mu.Unlock()
	s.advance()
	c, ok := s.clusters[obj.GetName()]
	if !ok {
		return nil, notFound(obj.GetName())
	}
	if req.GetLock() && obj.GetResourceVersion() != c.GetResourceVersion() {
		return nil, status.Errorf(codes.Aborted, "object with identifier '%s' has resource version %s, the request carries %q; fetch it again and retry", obj.GetName(), c.GetResourceVersion(), obj.GetResourceVersion())
	}
	now := s.clock()
	for _, p := range paths {
		switch p {
		case PathLabels:
			c.Labels = copyMap(obj.GetLabels())
		case PathAnnotations:
			c.Annotations = copyMap(obj.GetAnnotations())
		case PathHubAcceptsClient:
			if c.GetHubAcceptsClient() == obj.GetHubAcceptsClient() {
				continue
			}
			c.HubAcceptsClient = obj.GetHubAcceptsClient()
			c.Generation++ // a spec change
			if c.HubAcceptsClient {
				setCondition(c, now, CondHubAccepted, aigridv1.ConditionStatus_CONDITION_STATUS_TRUE, ReasonHubAccepted, MessageHubAccepted)
			} else {
				setCondition(c, now, CondHubAccepted, aigridv1.ConditionStatus_CONDITION_STATUS_FALSE, ReasonHubDenied, MessageHubDenied)
			}
		}
	}
	s.bumpResourceVersion(c)
	s.logger.Debug("cluster updated", "name", c.GetName(), "paths", paths, "resourceVersion", c.GetResourceVersion())
	return &aigridv1.UpdateManagedClusterResponse{Object: withDerivedState(c)}, nil
}

// copyMap returns an owned, non-nil copy so the request cannot alias the
// store. An empty map is kept as empty (whole-map replacement semantics).
func copyMap(m map[string]string) map[string]string {
	if m == nil {
		return map[string]string{}
	}
	return maps.Clone(m)
}
