import { render, screen, within } from '@testing-library/react';
import { MemoryRouter } from 'react-router-dom';
import { describe, expect, it } from 'vitest';
import { DeploymentStatusModal } from './DeploymentStatusModal';
import { siteDeploymentConditions } from './siteDeploymentConditions';

const createdAt = '2026-10-14T20:10:06.000Z';

describe('siteDeploymentConditions', () => {
  it('marks every step success when the site is Ready', () => {
    const steps = siteDeploymentConditions('Ready', createdAt);
    expect(steps.every((step) => step.status === 'True')).toBe(true);
    expect(steps.map((step) => step.type)).toContain('DeploymentRequested');
    expect(steps.map((step) => step.type)).toContain('Ready');
  });

  it('fails the workload and ready steps when the site is Failed', () => {
    const steps = siteDeploymentConditions('Failed', createdAt);
    expect(steps.find((step) => step.type === 'DeploymentRequested')?.status).toBe('True');
    expect(steps.find((step) => step.type === 'WorkloadsReady')?.status).toBe('False');
    expect(steps.find((step) => step.type === 'Ready')?.status).toBe('False');
  });
});

describe('DeploymentStatusModal', () => {
  it('opens the progress tab with what the cluster reported, and links the cluster name', () => {
    render(
      <MemoryRouter>
        <DeploymentStatusModal
          title="Granite 8B Instruct"
          phase="Ready"
          locationLabel="Paris DC1 (paris)"
          cluster="site-paris-1"
          reason="Ready"
          message="LLMInferenceService ready"
          createdAt={createdAt}
          onClose={() => undefined}
        />
      </MemoryRouter>,
    );
    expect(screen.getByTestId('deployment-status-modal')).toBeVisible();
    expect(screen.getByRole('dialog')).toHaveClass('pf-m-md');
    const header = screen.getByTestId('deployment-status-modal-header');
    expect(header).toHaveTextContent('Granite 8B Instruct status');
    expect(screen.getByTestId('model-status-text')).toHaveTextContent('Ready');
    const subtitle = screen.getByTestId('deployment-status-subtitle');
    expect(subtitle.tagName).toBe('P');
    expect(subtitle).toHaveTextContent(/Deployment status for/);
    expect(screen.getByTestId('deployment-status-location')).toHaveTextContent('Paris DC1 (paris)');
    expect(within(subtitle).getByRole('link', { name: 'site-paris-1' })).toHaveAttribute(
      'href',
      '/clusters/site-paris-1',
    );
    expect(screen.getByTestId('deployment-status-steps')).toBeVisible();
    expect(screen.getByText('LLMInferenceService ready')).toBeVisible();
    expect(screen.queryByRole('button', { name: 'Edit deployment' })).not.toBeInTheDocument();
    expect(screen.queryByRole('button', { name: 'Stop deployment' })).not.toBeInTheDocument();
  });
});
