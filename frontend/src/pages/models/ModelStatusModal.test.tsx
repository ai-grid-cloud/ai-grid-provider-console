import type { ReactElement } from 'react';
import { render, screen } from '@testing-library/react';
import { MemoryRouter } from 'react-router-dom';
import { describe, expect, it } from 'vitest';
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

const renderModal = (ui: ReactElement) => render(<MemoryRouter>{ui}</MemoryRouter>);

describe('ModelStatusModal', () => {
  it('shows model name, status label, and Deployment status subtitle', () => {
    renderModal(
      <ModelStatusModal
        model={model({
          phase: 'Failed',
          reason: 'ConfigNotFound',
          statusMessage: 'template missing',
          locations: ['paris'],
        })}
        onClose={() => undefined}
      />,
    );
    expect(screen.getByRole('dialog')).toHaveClass('pf-m-md');
    expect(screen.getByTestId('model-status-modal-title')).toHaveTextContent('Granite 8B Instruct');
    expect(screen.getByTestId('model-status-text')).toHaveTextContent('Failed');
    expect(screen.getByTestId('model-status-modal-subtitle')).toHaveTextContent('Deployment status');
    expect(screen.getByTestId('model-status-modal-subtitle').tagName).toBe('P');
    expect(screen.getByText('Deployment failed')).toBeVisible();
    expect(screen.queryByRole('button', { name: 'Sync now' })).not.toBeInTheDocument();
    expect(screen.getByText('A runtime template this model needs isn’t installed on the hub.')).toBeVisible();
  });

  it('shows the locations table for Partially ready, without the summary sentence or a link back to the list', () => {
    renderModal(
      <ModelStatusModal
        model={model({
          phase: 'Partially ready',
          statusMessage: 'Not ready on madrid; ready on paris',
          clusters: [
            { cluster: 'site-madrid-1', phase: 'Pending', reason: 'NotReady' },
            { cluster: 'site-paris-1', phase: 'Ready', reason: 'Ready' },
          ],
        })}
        clusters={[
          { name: 'site-madrid-1', location: 'madrid' },
          { name: 'site-paris-1', location: 'paris', consoleUrl: 'https://console.example.com' },
        ]}
        siteNames={new Map([['paris', 'Paris DC1']])}
        onClose={() => undefined}
      />,
    );
    expect(screen.getByRole('dialog')).toHaveClass('pf-m-md');
    expect(screen.getByTestId('model-status-text')).toHaveTextContent('Partially ready');
    expect(screen.getByText('One or more model deployments are not ready')).toBeVisible();
    expect(screen.getByTestId('model-clusters-granite-8b-instruct')).toBeVisible();
    expect(screen.getByRole('link', { name: 'site-madrid-1' })).toHaveAttribute('href', '/clusters/site-madrid-1');
    expect(screen.queryByText('Not ready on madrid; ready on paris')).not.toBeInTheDocument();
    expect(screen.queryByRole('button', { name: 'View model deployments per location' })).not.toBeInTheDocument();
  });
});
