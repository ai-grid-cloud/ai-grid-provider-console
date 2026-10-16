package fakebackend

import (
	"sort"
	"strings"
	"time"

	"google.golang.org/protobuf/proto"
	"google.golang.org/protobuf/types/known/timestamppb"

	aigridv1 "github.com/ai-grid-cloud/ai-grid-provider-console/bff/gen/ai_grid/v1"
)

// Strings the hub writes on a ManagedCluster. Every value comes from
// mock/research/acm.md section 1, which cites the controller source for each
// one; nothing here is invented. Keep them verbatim: the UI and the real
// backend will match on them.
const (
	// Condition types (`status.conditions[].type`).
	CondHubAccepted     = "HubAcceptedManagedCluster"
	CondJoined          = "ManagedClusterJoined"
	CondAvailable       = "ManagedClusterConditionAvailable"
	CondClockSynced     = "ManagedClusterConditionClockSynced"
	CondImportSucceeded = "ManagedClusterImportSucceeded"
	// Deleting is written by the hub gc controller while the resource-cleanup
	// finalizer drains ManifestWorks and add-ons (api:cluster/v1/types.go).
	CondDeleting = "Deleting"

	// HubAcceptedManagedCluster (hub registration controller).
	ReasonHubAccepted  = "HubClusterAdminAccepted"
	MessageHubAccepted = "Accepted by hub cluster admin"
	ReasonHubDenied    = "HubClusterAdminDenied"
	MessageHubDenied   = "Denied by hub cluster admin"

	// ManagedClusterJoined (spoke agent); never set to False.
	ReasonJoined  = "ManagedClusterJoined"
	MessageJoined = "Managed cluster joined"

	// ManagedClusterConditionAvailable (spoke agent, hub lease controller).
	ReasonAvailable           = "ManagedClusterAvailable"
	MessageAvailable          = "Managed cluster is available"
	ReasonAPIServerUnavail    = "ManagedClusterKubeAPIServerUnavailable"
	MessageAPIServerUnavailFm = "The kube-apiserver is not ok, status code: %d, %v"
	ReasonLeaseStopped        = "ManagedClusterLeaseUpdateStopped"
	MessageLeaseStopped       = "Registration agent stopped updating its lease."

	// ManagedClusterConditionClockSynced (hub clock-sync controller).
	ReasonClockSynced     = "ManagedClusterClockSynced"
	MessageClockSynced    = "The clock of the managed cluster is synced with the hub."
	ReasonClockOutOfSync  = "ManagedClusterClockOutOfSync"
	MessageClockOutOfSync = "The clock of hub and agent is out of sync. This may cause the Unknown status and affect agent functionalities."

	// ManagedClusterImportSucceeded (ACM import controller).
	ReasonWaitForImporting   = "ManagedClusterWaitForImporting"
	MessageWaitForImporting  = "Wait for importing"
	ReasonImporting          = "ManagedClusterImporting"
	MessageImportStart       = "Start to import managed cluster"
	MessageImportWaitSecret  = "Wait for import secret"
	MessageImportApplied     = "Importing resources are applied, wait for resources be available"
	MessageImportNoWorks     = "Expect klusterlet manifestworks created, but got none. Will retry"
	ReasonImportFailed       = "ManagedClusterImportFailed"
	MessageImportFailedFmt   = "Try to import managed cluster, error: %v"
	ReasonImported           = "ManagedClusterImported"
	MessageImported          = "Import succeeded"
	ReasonDetaching          = "ManagedClusterDetaching"
	MessageDetaching         = "The managed cluster is being detached now"
	ReasonForceDetaching     = "ManagedClusterForceDetaching"
	MessageForceDetaching    = "The managed cluster is being detached by force"
	MessageImportWaitSecretH = "Wait for import secret to be created"

	// Deleting reasons (api:cluster/v1/types.go). The research verified the
	// reasons but not the message text, so the fake leaves the message empty;
	// see mock/research/acm.md section 1, "Conditions and who writes them".
	ReasonResourceRemaining = "ResourceRemaining"
	ReasonNoResource        = "NoResource"
	ReasonDeletingError     = "DeletingError"

	// Taints the hub's taint controller adds, both with effect NoSelect.
	TaintUnavailable = "cluster.open-cluster-management.io/unavailable"
	TaintUnreachable = "cluster.open-cluster-management.io/unreachable"
	TaintNoSelect    = "NoSelect"

	// Labels ACM writes.
	LabelName              = "name"
	LabelCloud             = "cloud"
	LabelVendor            = "vendor"
	LabelClusterID         = "clusterID"
	LabelOpenShiftVersion  = "openshiftVersion"
	LabelOpenShiftMajor    = "openshiftVersion-major"
	LabelOpenShiftMajorMin = "openshiftVersion-major-minor"
	LabelClusterSet        = "cluster.open-cluster-management.io/clusterset"
	LabelLocalCluster      = "local-cluster"
	LabelAddonPrefix       = "feature.open-cluster-management.io/addon-"
	LabelAutoDetect        = "auto-detect"
	// LabelManagedBy accompanies the OpenShiftDedicated -> OpenShift vendor
	// rewrite (acm.md section 1, `vendor` row).
	LabelManagedBy = "managed-by"

	// Values of the addon labels, mirroring each ManagedClusterAddOn's
	// Available condition: True, False, Unknown or missing.
	AddonAvailable   = "available"
	AddonUnhealthy   = "unhealthy"
	AddonUnreachable = "unreachable"

	// Claims the console and the autodetect controller read.
	ClaimID          = "id.k8s.io"
	ClaimPlatform    = "platform.open-cluster-management.io"
	ClaimProduct     = "product.open-cluster-management.io"
	ClaimOCPVersion  = "version.openshift.io"
	ClaimKubeVersion = "kubeversion.open-cluster-management.io"
	ClaimConsoleURL  = "consoleurl.cluster.open-cluster-management.io"
)

// defaultAddons are the add-ons a plain ACM import enables; their labels
// appear one by one once the cluster is imported. The dev hub lists nine,
// including hypershift and observability which need extra operators.
var defaultAddons = []string{
	"application-manager",
	"cert-policy-controller",
	"cluster-proxy",
	"config-policy-controller",
	"governance-policy-framework",
	"managed-serviceaccount",
	"work-manager",
}

// platformToCloud is the autodetect controller's mapping from the platform
// claim to the `cloud` label (multicloud-operators-foundation autodetect).
var platformToCloud = map[string]string{
	"AWS": "Amazon", "GCP": "Google", "Azure": "Azure", "IBM": "IBM", "IBMPowerPlatform": "IBMPowerPlatform",
	"IBMZPlatform": "IBMZPlatform", "OpenStack": "OpenStack", "VSphere": "VSphere", "RHV": "RHV",
	"AlibabaCloud": "AlibabaCloud", "BareMetal": "BareMetal", "Nutanix": "Nutanix", "KubeVirt": "Other", "Other": "Other",
}

// productToVendor maps the product claim to the `vendor` label. Every
// OpenShift flavour reports `OpenShift` (OpenShiftDedicated is rewritten too).
var productToVendor = map[string]string{
	"OpenShift": "OpenShift", "OpenShiftDedicated": "OpenShift", "ROSA": "OpenShift", "ARO": "OpenShift", "ROKS": "OpenShift",
	"MicroShift": "MicroShift", "AKS": "AKS", "EKS": "EKS", "GKE": "GKE", "IKS": "IKS", "ICP": "ICP", "Other": "Other",
}

// findCondition returns the condition of the given type, or nil.
func findCondition(c *aigridv1.ManagedCluster, typ string) *aigridv1.Condition {
	for _, cond := range c.GetStatus().GetConditions() {
		if cond.GetType() == typ {
			return cond
		}
	}
	return nil
}

// isTrue mirrors the ACM console's checkForCondition: True only when the
// condition exists and its status is True.
func isTrue(c *aigridv1.ManagedCluster, typ string) bool {
	return findCondition(c, typ).GetStatus() == aigridv1.ConditionStatus_CONDITION_STATUS_TRUE
}

// setCondition writes a condition the way a controller does: the status,
// reason and message are replaced and lastTransitionTime moves only when the
// status actually changes. observedGeneration is left unset: the hub's
// ManagedCluster conditions never carry it (checked on the dev hub).
func setCondition(c *aigridv1.ManagedCluster, now time.Time, typ string, st aigridv1.ConditionStatus, reason, message string) {
	if c.Status == nil {
		c.Status = &aigridv1.ManagedClusterStatus{}
	}
	cond := findCondition(c, typ)
	if cond == nil {
		cond = &aigridv1.Condition{Type: typ, LastTransitionTime: timestamppb.New(now)}
		c.Status.Conditions = append(c.Status.Conditions, cond)
	} else if cond.GetStatus() != st {
		cond.LastTransitionTime = timestamppb.New(now)
	}
	cond.Status = st
	cond.Reason = proto.String(reason)
	cond.Message = proto.String(message)
}

// hasTaint reports whether a taint with that key is present.
func hasTaint(c *aigridv1.ManagedCluster, key string) bool {
	for _, t := range c.GetTaints() {
		if t.GetKey() == key {
			return true
		}
	}
	return false
}

// addTaint adds a hub taint with NoSelect and timeAdded (the mutating
// webhook's stamp); a second add is a no-op like on the hub.
func addTaint(c *aigridv1.ManagedCluster, now time.Time, key string) {
	if hasTaint(c, key) {
		return
	}
	c.Taints = append(c.Taints, &aigridv1.Taint{Key: key, Effect: TaintNoSelect, TimeAdded: timestamppb.New(now)})
}

// removeTaint drops every taint with that key.
func removeTaint(c *aigridv1.ManagedCluster, key string) {
	kept := c.GetTaints()[:0]
	for _, t := range c.GetTaints() {
		if t.GetKey() != key {
			kept = append(kept, t)
		}
	}
	c.Taints = kept
}

// setAddonLabels sets every `feature.open-cluster-management.io/addon-*`
// label to value, as the addon discovery controller does when the agent
// stops reporting (unreachable) or reports again (available).
func setAddonLabels(c *aigridv1.ManagedCluster, value string) {
	for k := range c.GetLabels() {
		if strings.HasPrefix(k, LabelAddonPrefix) {
			c.Labels[k] = value
		}
	}
}

// claim returns a claim value or "".
func claim(c *aigridv1.ManagedCluster, name string) string {
	for _, cl := range c.GetStatus().GetClusterClaims() {
		if cl.GetName() == name {
			return cl.GetValue()
		}
	}
	return ""
}

// sortClaims orders the claims by name, as the hub reports them.
func sortClaims(c *aigridv1.ManagedCluster) {
	claims := c.GetStatus().GetClusterClaims()
	sort.SliceStable(claims, func(i, j int) bool { return claims[i].GetName() < claims[j].GetName() })
}

// autodetectLabels is the foundation autodetect controller: it fills
// `cloud` and `vendor` only while they are `auto-detect` (or missing), and
// always writes `clusterID` and the three `openshiftVersion*` labels from the
// claims the agent synced.
func autodetectLabels(c *aigridv1.ManagedCluster) {
	if c.Labels == nil {
		c.Labels = map[string]string{}
	}
	if p := claim(c, ClaimPlatform); p != "" {
		if cur, ok := c.Labels[LabelCloud]; !ok || cur == LabelAutoDetect {
			if cloud, known := platformToCloud[p]; known {
				c.Labels[LabelCloud] = cloud
			} else {
				c.Labels[LabelCloud] = "Other"
			}
		}
	}
	if p := claim(c, ClaimProduct); p != "" {
		if cur, ok := c.Labels[LabelVendor]; !ok || cur == LabelAutoDetect {
			if vendor, known := productToVendor[p]; known {
				c.Labels[LabelVendor] = vendor
			} else {
				c.Labels[LabelVendor] = "Other"
			}
			if p == "OpenShiftDedicated" {
				c.Labels[LabelManagedBy] = "platform"
			}
		}
	}
	if id := claim(c, ClaimID); id != "" {
		c.Labels[LabelClusterID] = id
	}
	if v := claim(c, ClaimOCPVersion); v != "" {
		c.Labels[LabelOpenShiftVersion] = v
		parts := strings.Split(v, ".")
		if len(parts) >= 1 {
			c.Labels[LabelOpenShiftMajor] = parts[0]
		}
		if len(parts) >= 2 {
			c.Labels[LabelOpenShiftMajorMin] = parts[0] + "." + parts[1]
		}
	}
}
