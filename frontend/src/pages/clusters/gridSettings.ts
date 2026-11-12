// What Edit reads from an AI Grid cluster and writes back with Clusters/Update: the `location` label,
// and the `ai-grid/role` label only while the cluster has none. The backend decides what a value
// means and refuses what it won't store; the form only checks what it can show as field errors
// before sending, and the backend's answer stays the one that counts.
import type { ClusterRole } from '../../api/clusters';
import { LABEL_LOCATION, LABEL_ROLE, type ClusterView } from './clusterView';
import { roleOf } from './roles';

// A Kubernetes label value: what the hub accepts for `location`.
const labelValue = /^[A-Za-z0-9]([-A-Za-z0-9_.]{0,61}[A-Za-z0-9])?$/;

/** What is wrong with a location label, trimmed, as Add and Edit check it; undefined when the hub accepts it. */
export const locationError = (location: string) => {
  if (!location) return 'Required';
  if (!labelValue.test(location)) {
    return 'Must start and end with a letter or number. Valid characters include letters, numbers, hyphens (-), underscores (_), and periods (.). Up to 63 characters.';
  }
  return undefined;
};

/** The values the dialog edits, as text, trimmed when read from the cluster. */
export type GridSettings = { role: ClusterRole | ''; location: string };

export type GridSettingsField = keyof GridSettings;

/**
 * The cluster's settings as the dialog starts from them: its role when it is one of the three (a
 * role label holding anything else reads as none), and its location label trimmed.
 */
export const settingsOf = (c: ClusterView): GridSettings => ({
  role: roleOf(c.labels)?.value ?? '',
  location: (c.labels[LABEL_LOCATION] ?? '').trim(),
});

/**
 * Edit sets a role only on a cluster without one: changing a role a cluster has isn't supported,
 * because the hub doesn't fully remove what the old role installed (editClusterText.ts).
 */
export const canSetRole = (c: ClusterView) => settingsOf(c).role === '';

/** Each field's error, for the values as entered: the location label as Add checks it, and a role. */
export const settingsErrors = (s: GridSettings): Partial<Record<GridSettingsField, string>> => {
  const errors: Partial<Record<GridSettingsField, string>> = {};
  const location = locationError(s.location.trim());
  if (location) errors.location = location;
  if (!s.role) errors.role = 'Required';
  return errors;
};

/**
 * The labels saving writes, or undefined when nothing changes: the cluster's labels as read, with
 * the location label and, on a cluster without a role, the role set. The role a cluster already
 * has is never changed, whatever the form holds. The backend takes the ai-grid/* keys and the
 * location label in the map as the whole set and every other key as read, so the map is sent whole.
 */
export const labelsUpdate = (cluster: ClusterView, edited: GridSettings): Record<string, string> | undefined => {
  const before = settingsOf(cluster);
  const labels = { ...cluster.labels };
  let changed = false;
  const location = edited.location.trim();
  if (location !== before.location) {
    labels[LABEL_LOCATION] = location;
    changed = true;
  }
  if (canSetRole(cluster) && edited.role) {
    labels[LABEL_ROLE] = edited.role;
    changed = true;
  }
  return changed ? labels : undefined;
};
