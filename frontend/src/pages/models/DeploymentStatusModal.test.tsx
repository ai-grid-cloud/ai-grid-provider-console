import { render, screen, within } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { describe, expect, it, vi } from 'vitest';
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
  it('opens the progress tab with what the cluster reported, and stop and edit actions', async () => {
    const user = userEvent.setup();
    const onClose = vi.fn();
    const onEdit = vi.fn();
    const onStop = vi.fn();
    render(
      <DeploymentStatusModal
        title="Granite 8B Instruct"
        phase="Ready"
        locationLabel="Paris DC1 (paris)"
        cluster="site-paris-1"
        reason="Ready"
        message="LLMInferenceService ready"
        createdAt={createdAt}
        onClose={onClose}
        onEdit={onEdit}
        onStop={onStop}
      />,
    );
    expect(screen.getByTestId('deployment-status-modal')).toBeVisible();
    const header = screen.getByTestId('deployment-status-modal-header');
    expect(header).toHaveTextContent('Granite 8B Instruct status');
    expect(screen.getByTestId('model-status-text')).toHaveTextContent('Ready');
    const subtitle = screen.getByTestId('deployment-status-subtitle');
    expect(subtitle.tagName).toBe('P');
    expect(subtitle).toHaveTextContent(/Deployment status for/);
    expect(screen.getByTestId('deployment-status-location')).toHaveTextContent('Paris DC1 (paris)');
    expect(subtitle).toHaveTextContent('on cluster site-paris-1');
    expect(within(subtitle).getByTestId('deployment-status-location')).toBeVisible();
    expect(screen.getByTestId('deployment-status-steps')).toBeVisible();
    expect(screen.getByText('LLMInferenceService ready')).toBeVisible();
    await user.click(screen.getByTestId('deployment-status-edit-button'));
    expect(onEdit).toHaveBeenCalled();
    await user.click(screen.getByTestId('deployment-status-stop-button'));
    expect(onStop).toHaveBeenCalled();
  });
});
