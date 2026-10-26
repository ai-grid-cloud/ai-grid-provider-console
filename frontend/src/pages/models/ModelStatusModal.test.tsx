import { render, screen } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { describe, expect, it, vi } from 'vitest';
import { ModelStatusModal } from './ModelStatusModal';
import type { ModelView } from './modelView';

const model = (partial: Partial<ModelView>): ModelView => ({
  id: 'granite-8b-instruct',
  displayName: 'Granite 8B Instruct',
  baseRefs: [],
  autoscaled: false,
  env: [],
  annotations: {},
  phase: 'Ready',
  version: 1,
  locations: ['paris', 'madrid'],
  selectedClusters: [],
  clusters: [],
  placed: true,
  ...partial,
});

describe('ModelStatusModal', () => {
  it('shows model name, status label, and Deployment status subtitle', () => {
    render(
      <ModelStatusModal
        model={model({
          phase: 'Failed',
          reason: 'ConfigNotFound',
          statusMessage: 'template missing',
          locations: ['paris'],
        })}
        onClose={vi.fn()}
      />,
    );
    expect(screen.getByTestId('model-status-modal-title')).toHaveTextContent('Granite 8B Instruct');
    expect(screen.getByTestId('model-status-text')).toHaveTextContent('Failed');
    expect(screen.getByTestId('model-status-modal-subtitle')).toHaveTextContent('Deployment status');
    expect(screen.getByTestId('model-status-modal-subtitle').tagName).toBe('P');
    expect(screen.getByText('Deployment failed')).toBeVisible();
    expect(screen.getByText('A runtime template this model needs isn’t installed on the hub.')).toBeVisible();
  });

  it('offers a link to view per-location deployments when Partially available', async () => {
    const user = userEvent.setup();
    const onViewDeployments = vi.fn();
    render(
      <ModelStatusModal
        model={model({
          phase: 'Partially available',
          statusMessage: 'Not ready on madrid; ready on paris',
        })}
        onClose={vi.fn()}
        onViewDeployments={onViewDeployments}
      />,
    );
    expect(screen.getByTestId('model-status-text')).toHaveTextContent('Partially available');
    expect(screen.getByTestId('model-status-modal-message')).toHaveTextContent(
      'One or more model deployments are not ready',
    );
    expect(screen.getByText('Not ready on madrid; ready on paris')).toBeVisible();
    await user.click(screen.getByTestId('model-status-view-deployments'));
    expect(onViewDeployments).toHaveBeenCalled();
  });
});
