// Ported from krisv/ai-grid-cloud-provider-poc src/app/shared/AddModelsModal.tsx at 62319b8.
// Adapted from opendatahub-io/odh-dashboard
// packages/maas/frontend/src/app/shared/AddModelsModal.tsx
// upstream commit: 8051fbbea117457b4da4074fb2856b732e6677a4
import { useEffect, useId, useMemo, useState } from 'react';
import {
  Button,
  Checkbox,
  Modal,
  ModalBody,
  ModalFooter,
  ModalHeader,
  SearchInput,
  Stack,
  StackItem,
} from '@patternfly/react-core';
import { Table, Tbody, Td, Th, Thead, Tr } from '@patternfly/react-table';
import { entryModelId, type SubscriptionModelEntry } from '../pages/subscriptions/hooks/useSubscriptionModels';
import { titleOf, type ModelView } from '../pages/models/modelView';
import type { ClusterPlaces } from '../pages/models/clusterPlaces';
import { ModelStatusLabel } from '../pages/models/ModelStatus';
import { ModelStatusContent } from '../pages/models/ModelStatusModal';
import { hasPartialModelStatus } from '../pages/subscriptions/partialModelStatus';
import { useModelList } from '../pages/models/useModels';
import { LoadError } from './LoadError';
import { PageLoading } from './PageLoading';

type Props = {
  currentModels: SubscriptionModelEntry[];
  status?: { model: ModelView; clusters: ClusterPlaces; onClose: () => void };
  focusModelId?: string;
  onOpenStatus?: (model: ModelView) => void;
  onAdd: (models: ModelView[]) => void;
  onRemove: (models: ModelView[]) => void;
  onClose: () => void;
};

const toggled = (set: Set<string>, key: string) => {
  const next = new Set(set);
  if (next.has(key)) next.delete(key);
  else next.add(key);
  return next;
};

/**
 * Picks the models of a subscription: a checkbox per model (checked for the ones it has), with
 * each model's status, so a failed or pending model isn't added unnoticed.
 */
export const AddModelsModal: React.FC<Props> = ({
  currentModels,
  onAdd,
  onRemove,
  onClose,
  status,
  focusModelId,
  onOpenStatus,
}) => {
  const dialogId = useId();
  const statusModelId = status?.model.id;
  // Replacing content keeps one focus trap; restore focus when the original picker content returns.
  useEffect(() => {
    if (statusModelId) {
      document.getElementById(dialogId)?.querySelector<HTMLButtonElement>('button[aria-label="Close"]')?.focus();
    } else if (focusModelId) {
      const trigger = document
        .getElementById(`picker-status-${focusModelId}`)
        ?.querySelector<HTMLButtonElement>('button');
      (
        trigger ?? document.getElementById(dialogId)?.querySelector<HTMLButtonElement>('button[aria-label="Close"]')
      )?.focus();
    }
  }, [dialogId, statusModelId, focusModelId]);

  // Every model, from Models/List: the picker is the one place a subscription page reads the fleet.
  const { data: availableModels, loaded, error, refresh } = useModelList();
  const [filter, setFilter] = useState('');
  const [sortDirection, setSortDirection] = useState<'asc' | 'desc'>('asc');
  const [pendingAdds, setPendingAdds] = useState<Set<string>>(new Set());
  const [pendingRemoves, setPendingRemoves] = useState<Set<string>>(new Set());

  // Pending changes are keyed by the models' ids; a subscription's ref names its model by the
  // backend's join (SubscriptionModelRef.model_id).
  const isCurrent = (model: ModelView) => currentModels.some((m) => entryModelId(m) === model.id);

  const isInCurrentSelection = (model: ModelView) =>
    (isCurrent(model) && !pendingRemoves.has(model.id)) || pendingAdds.has(model.id);

  const filteredModels = useMemo(() => {
    const lowerFilter = filter.toLowerCase();
    return availableModels
      .filter((model) => !lowerFilter || (model.displayName ?? model.id).toLowerCase().includes(lowerFilter))
      .sort((a, b) => {
        const cmp = (a.displayName ?? a.id).localeCompare(b.displayName ?? b.id);
        return sortDirection === 'asc' ? cmp : -cmp;
      });
  }, [availableModels, filter, sortDirection]);

  const handleToggleModel = (model: ModelView) => {
    if (isCurrent(model)) {
      setPendingRemoves((prev) => toggled(prev, model.id));
    } else {
      setPendingAdds((prev) => toggled(prev, model.id));
    }
  };

  const handleConfirm = () => {
    const refsToAdd = availableModels.filter((model) => pendingAdds.has(model.id));
    const refsToRemove = availableModels.filter((model) => pendingRemoves.has(model.id));
    if (refsToRemove.length > 0) {
      onRemove(refsToRemove);
    }
    if (refsToAdd.length > 0) {
      onAdd(refsToAdd);
    }
    onClose();
  };

  return (
    <Modal
      id={dialogId}
      isOpen
      onClose={status?.onClose ?? onClose}
      variant={status ? 'medium' : 'large'}
      aria-label={status ? `${titleOf(status.model)} status` : 'Add models'}
      data-testid="add-models-modal"
    >
      {status ? (
        <ModelStatusContent model={status.model} clusters={status.clusters} />
      ) : (
        <>
          <ModalHeader title="Add models" />
          <ModalBody>
            <Stack hasGutter>
              <StackItem>Select models to make available to members of this subscription.</StackItem>
              <StackItem>
                <SearchInput
                  placeholder="Filter by model name"
                  value={filter}
                  onChange={(_e, val) => setFilter(val)}
                  onClear={() => setFilter('')}
                  data-testid="add-models-filter"
                />
              </StackItem>
              {!loaded && (
                <StackItem>
                  <PageLoading label="Loading models" />
                </StackItem>
              )}
              {loaded && error && (
                <StackItem>
                  <LoadError subject="Models" error={error} onRetry={() => void refresh()} />
                </StackItem>
              )}
              {loaded && !error && (
                <StackItem>
                  <Table aria-label="Available models" data-testid="add-models-table">
                    <Thead>
                      <Tr>
                        <Th screenReaderText="Selected" />
                        <Th
                          sort={{
                            sortBy: { index: 0, direction: sortDirection },
                            onSort: () => setSortDirection((prev) => (prev === 'asc' ? 'desc' : 'asc')),
                            columnIndex: 0,
                          }}
                        >
                          Model name
                        </Th>
                        <Th>Status</Th>
                      </Tr>
                    </Thead>
                    <Tbody>
                      {filteredModels.map((model, rowIndex) => {
                        const name = model.displayName ?? model.id;
                        const openStatus =
                          onOpenStatus && hasPartialModelStatus(model) ? () => onOpenStatus(model) : undefined;
                        return (
                          <Tr key={model.id}>
                            {/* PatternFly's select cell names every box "Select row N"; this one names the model. */}
                            <Td className="pf-v6-c-table__check">
                              <Checkbox
                                id={`add-model-${rowIndex}`}
                                aria-label={`Select ${name}`}
                                data-testid={`toggle-model-${model.id}`}
                                isChecked={isInCurrentSelection(model)}
                                onChange={() => handleToggleModel(model)}
                              />
                            </Td>
                            <Td dataLabel="Model name">{name}</Td>
                            <Td dataLabel="Status">
                              {/* The Models list's label and word (model.state) for every row; only an
                                  eligible row opens the status. */}
                              <span id={`picker-status-${model.id}`}>
                                <ModelStatusLabel model={model} onOpen={openStatus} />
                              </span>
                            </Td>
                          </Tr>
                        );
                      })}
                      {filteredModels.length === 0 && (
                        <Tr>
                          <Td colSpan={3}>No models match the filter criteria.</Td>
                        </Tr>
                      )}
                    </Tbody>
                  </Table>
                </StackItem>
              )}
            </Stack>
          </ModalBody>
          <ModalFooter>
            <Button
              variant="primary"
              onClick={handleConfirm}
              isDisabled={!loaded || !!error}
              data-testid="confirm-add-models"
            >
              {currentModels.length ? 'Update models' : 'Add'}
            </Button>
            <Button variant="link" onClick={onClose}>
              Cancel
            </Button>
          </ModalFooter>
        </>
      )}
    </Modal>
  );
};
