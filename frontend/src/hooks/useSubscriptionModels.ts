// Ported from krisv/ai-grid-cloud-provider-poc src/app/hooks/useSubscriptionModels.ts at 62319b8.
// Adapted from opendatahub-io/odh-dashboard
// packages/maas/frontend/src/app/hooks/useSubscriptionModels.ts
// upstream commit: 8051fbbea117457b4da4074fb2856b732e6677a4
import { useCallback, useState } from 'react';
import type { MaaSModelRefSummary, TokenRateLimit } from '../api/types';
import { isSameModel } from '../utilities/authpolicies';

/** A model in the subscription form, with its token limits. */
export type SubscriptionModelEntry = {
  unlimited?: boolean;
  modelRefSummary: MaaSModelRefSummary;
  tokenRateLimits: TokenRateLimit[];
};

/** Returns the corrected edit-modal row index after deletions, or null if that row was removed. */
export const reindexAfterRemove = (targetIndex: number | null, removedIndices: number[]): number | null => {
  if (targetIndex === null || removedIndices.length === 0) {
    return targetIndex;
  }
  if (removedIndices.includes(targetIndex)) {
    return null;
  }
  return targetIndex - removedIndices.filter((i) => i < targetIndex).length;
};

/** The form's model list, the add-models modal and the token-limit modal. */
export const useSubscriptionModels = (initialModels: SubscriptionModelEntry[] = []) => {
  const [models, setModels] = useState<SubscriptionModelEntry[]>(initialModels);
  const [isAddModelsModalOpen, setIsAddModelsModalOpen] = useState(false);
  const [editLimitsTarget, setEditLimitsTarget] = useState<number | null>(null);

  const allModelsHaveRateLimits = models.every((m) => m.unlimited || m.tokenRateLimits.length > 0);
  const editingModel = editLimitsTarget != null ? models[editLimitsTarget] : null;

  const handleAddModels = useCallback((selectedRefs: MaaSModelRefSummary[]) => {
    setModels((prev) => {
      const newEntries: SubscriptionModelEntry[] = selectedRefs
        .filter((ref) => !prev.some((m) => isSameModel(m.modelRefSummary, ref)))
        .map((ref) => ({ modelRefSummary: ref, tokenRateLimits: [] }));
      return [...prev, ...newEntries];
    });
  }, []);

  const handleRemoveModel = useCallback((index: number) => {
    setModels((prev) => prev.filter((_, i) => i !== index));
    setEditLimitsTarget((current) => reindexAfterRemove(current, [index]));
  }, []);

  const handleRemoveModelsByRef = useCallback(
    (refs: MaaSModelRefSummary[]) => {
      const removed = (m: SubscriptionModelEntry) => refs.some((r) => isSameModel(r, m.modelRefSummary));
      const removedIndices = models.flatMap((m, i) => (removed(m) ? [i] : []));
      setModels((prev) => prev.filter((m) => !removed(m)));
      setEditLimitsTarget((current) => reindexAfterRemove(current, removedIndices));
    },
    [models],
  );

  const handleSaveRateLimits = useCallback(
    (rateLimits: TokenRateLimit[]) => {
      if (editLimitsTarget == null) {
        return;
      }
      setModels((prev) =>
        prev.map((entry, i) => (i === editLimitsTarget ? { ...entry, tokenRateLimits: rateLimits } : entry)),
      );
      setEditLimitsTarget(null);
    },
    [editLimitsTarget],
  );

  const handleCloseRateLimitsModal = useCallback(() => setEditLimitsTarget(null), []);

  return {
    models,
    isAddModelsModalOpen,
    setIsAddModelsModalOpen,
    editLimitsTarget,
    setEditLimitsTarget,
    editingModel,
    allModelsHaveRateLimits,
    handleAddModels,
    handleRemoveModel,
    handleRemoveModelsByRef,
    handleSaveRateLimits,
    handleCloseRateLimitsModal,
  };
};
