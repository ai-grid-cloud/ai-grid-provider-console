package fakebackend

import (
	aigridv1 "github.com/ai-grid-cloud/ai-grid-provider-console/bff/gen/ai_grid/v1"
)

// deriveState computes the summary state and the message of the condition
// that decided it, in the order the ACM console uses
// (console:frontend/src/resources/utils/get-cluster.ts, transcribed in
// mock/research/acm.md section 1). "Not True" means False or absent.
//
// The real backend is asked to do the same server-side so that the console
// and the ACM console never disagree about a cluster.
func deriveState(c *aigridv1.ManagedCluster) (aigridv1.ManagedClusterState, string) {
	msg := func(typ string) string { return findCondition(c, typ).GetMessage() }

	if c.GetDeletionTimestamp() != nil {
		return aigridv1.ManagedClusterState_MANAGED_CLUSTER_STATE_DETACHING, msg(CondImportSucceeded)
	}
	if len(c.GetStatus().GetConditions()) == 0 {
		return aigridv1.ManagedClusterState_MANAGED_CLUSTER_STATE_UNSPECIFIED, ""
	}
	if !isTrue(c, CondHubAccepted) {
		return aigridv1.ManagedClusterState_MANAGED_CLUSTER_STATE_NOT_ACCEPTED, msg(CondHubAccepted)
	}
	if !isTrue(c, CondJoined) {
		imp := findCondition(c, CondImportSucceeded)
		if imp.GetStatus() == aigridv1.ConditionStatus_CONDITION_STATUS_FALSE {
			switch imp.GetReason() {
			case ReasonImporting:
				return aigridv1.ManagedClusterState_MANAGED_CLUSTER_STATE_IMPORTING, imp.GetMessage()
			case ReasonImportFailed:
				return aigridv1.ManagedClusterState_MANAGED_CLUSTER_STATE_IMPORT_FAILED, imp.GetMessage()
			}
		}
		return aigridv1.ManagedClusterState_MANAGED_CLUSTER_STATE_PENDING_IMPORT, imp.GetMessage()
	}
	avail := findCondition(c, CondAvailable)
	switch avail.GetStatus() {
	case aigridv1.ConditionStatus_CONDITION_STATUS_TRUE:
		return aigridv1.ManagedClusterState_MANAGED_CLUSTER_STATE_AVAILABLE, avail.GetMessage()
	case aigridv1.ConditionStatus_CONDITION_STATUS_FALSE:
		return aigridv1.ManagedClusterState_MANAGED_CLUSTER_STATE_UNAVAILABLE, avail.GetMessage()
	default:
		return aigridv1.ManagedClusterState_MANAGED_CLUSTER_STATE_UNKNOWN, avail.GetMessage()
	}
}

// withDerivedState fills `status.state` and `status.state_message` on a copy
// of the stored object. Fixtures may carry values for them, but they are
// never trusted: the stored object is the source and the summary is computed
// on every read, exactly as the real backend would.
func withDerivedState(c *aigridv1.ManagedCluster) *aigridv1.ManagedCluster {
	out := cloneCluster(c)
	if out.Status == nil {
		out.Status = &aigridv1.ManagedClusterStatus{}
	}
	out.Status.State, out.Status.StateMessage = deriveState(out)
	return out
}
