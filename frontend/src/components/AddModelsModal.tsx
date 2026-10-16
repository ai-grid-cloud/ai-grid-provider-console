// Ported from krisv/ai-grid-cloud-provider-poc src/app/shared/AddModelsModal.tsx at 62319b8.
// Adapted from opendatahub-io/odh-dashboard
// packages/maas/frontend/src/app/shared/AddModelsModal.tsx
// upstream commit: 8051fbbea117457b4da4074fb2856b732e6677a4
import { useMemo, useState } from 'react';
import {
  Button,
  Modal,
  ModalBody,
  ModalFooter,
  ModalHeader,
  SearchInput,
  Stack,
  StackItem,
} from '@patternfly/react-core';
import { Table, Tbody, Td, Th, Thead, Tr } from '@patternfly/react-table';
import type { MaaSModelRefSummary } from '../api/types';
import { isSameModel, modelKey } from '../utilities/authpolicies';

type Props = {
  availableModelRefs: MaaSModelRefSummary[];
  currentModels: { modelRefSummary: MaaSModelRefSummary }[];
  onAdd: (refs: MaaSModelRefSummary[]) => void;
  onRemove: (refs: MaaSModelRefSummary[]) => void;
  onClose: () => void;
};

const toggled = (set: Set<string>, key: string) => {
  const next = new Set(set);
  if (next.has(key)) next.delete(key);
  else next.add(key);
  return next;
};

/** Picks the models of a subscription from the models open to subscriptions. */
export const AddModelsModal: React.FC<Props> = ({ availableModelRefs, currentModels, onAdd, onRemove, onClose }) => {
  const [filter, setFilter] = useState('');
  const [sortDirection, setSortDirection] = useState<'asc' | 'desc'>('asc');
  const [pendingAdds, setPendingAdds] = useState<Set<string>>(new Set());
  const [pendingRemoves, setPendingRemoves] = useState<Set<string>>(new Set());

  // Pending changes are keyed by the available models' namespace and name.
  const isCurrent = (ref: MaaSModelRefSummary) => currentModels.some((m) => isSameModel(m.modelRefSummary, ref));

  const isInCurrentSelection = (ref: MaaSModelRefSummary) =>
    (isCurrent(ref) && !pendingRemoves.has(modelKey(ref))) || pendingAdds.has(modelKey(ref));

  const filteredModels = useMemo(() => {
    const lowerFilter = filter.toLowerCase();
    return availableModelRefs
      .filter((ref) => !lowerFilter || (ref.displayName ?? ref.name).toLowerCase().includes(lowerFilter))
      .sort((a, b) => {
        const cmp = (a.displayName ?? a.name).localeCompare(b.displayName ?? b.name);
        return sortDirection === 'asc' ? cmp : -cmp;
      });
  }, [availableModelRefs, filter, sortDirection]);

  const handleToggleModel = (ref: MaaSModelRefSummary) => {
    if (isCurrent(ref)) {
      setPendingRemoves((prev) => toggled(prev, modelKey(ref)));
    } else {
      setPendingAdds((prev) => toggled(prev, modelKey(ref)));
    }
  };

  const handleConfirm = () => {
    const refsToAdd = availableModelRefs.filter((ref) => pendingAdds.has(modelKey(ref)));
    const refsToRemove = availableModelRefs.filter((ref) => pendingRemoves.has(modelKey(ref)));
    if (refsToRemove.length > 0) {
      onRemove(refsToRemove);
    }
    if (refsToAdd.length > 0) {
      onAdd(refsToAdd);
    }
    onClose();
  };

  return (
    <Modal isOpen onClose={onClose} variant="large" aria-label="Add models" data-testid="add-models-modal">
      <ModalHeader title="Add models" />
      <ModalBody>
        <Stack hasGutter>
          <StackItem>
            Select models to make available to members of this subscription, then set token limits for each one.
          </StackItem>
          <StackItem>
            <SearchInput
              placeholder="Filter by model name"
              value={filter}
              onChange={(_e, val) => setFilter(val)}
              onClear={() => setFilter('')}
              data-testid="add-models-filter"
            />
          </StackItem>
          <StackItem>
            <Table aria-label="Available models" data-testid="add-models-table">
              <Thead>
                <Tr>
                  <Th
                    sort={{
                      sortBy: { index: 0, direction: sortDirection },
                      onSort: () => setSortDirection((prev) => (prev === 'asc' ? 'desc' : 'asc')),
                      columnIndex: 0,
                    }}
                  >
                    Model name
                  </Th>
                  <Th screenReaderText="Actions" />
                </Tr>
              </Thead>
              <Tbody>
                {filteredModels.map((ref) => {
                  const selected = isInCurrentSelection(ref);
                  return (
                    <Tr key={modelKey(ref)}>
                      <Td dataLabel="Model name">
                        <strong>{ref.displayName ?? ref.name}</strong>
                      </Td>
                      <Td isActionCell style={{ textAlign: 'center' }}>
                        <Button
                          variant={selected ? 'secondary' : 'link'}
                          size={selected ? 'sm' : 'default'}
                          isDanger={selected}
                          onClick={() => handleToggleModel(ref)}
                          data-testid={`toggle-model-${ref.name}`}
                        >
                          {selected ? 'Remove model' : 'Add model'}
                        </Button>
                      </Td>
                    </Tr>
                  );
                })}
                {filteredModels.length === 0 && (
                  <Tr>
                    <Td colSpan={2}>No models match the filter criteria.</Td>
                  </Tr>
                )}
              </Tbody>
            </Table>
          </StackItem>
        </Stack>
      </ModalBody>
      <ModalFooter>
        <Button variant="primary" onClick={handleConfirm} data-testid="confirm-add-models">
          Add models
        </Button>
        <Button variant="link" onClick={onClose}>
          Cancel
        </Button>
      </ModalFooter>
    </Modal>
  );
};
