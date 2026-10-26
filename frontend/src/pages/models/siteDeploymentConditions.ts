// Illustrative KServe-shaped progress for one location, adapted from odh-dashboard
// llmd-serving getLLMdDeploymentConditions. The backend reports one phase, reason and message per
// cluster (status.clusters). The stepper is the shape the dashboard shows for a deployment, filled
// from that phase: the fake and git mode do not send the full LLMInferenceService condition tree.

type ConditionStatus = 'True' | 'False' | 'Unknown';

export type DeploymentCondition = {
  type: string;
  label: string;
  status: ConditionStatus;
  lastTransitionTime?: string;
  message?: string;
  children?: DeploymentCondition[];
};

/**
 * Progress steps for a location, derived from the phase the backend reports for that cluster
 * (Ready / Pending / Failed).
 */
export const siteDeploymentConditions = (phase: string, baseTime: string | undefined): DeploymentCondition[] => {
  const start = baseTime ? new Date(baseTime).getTime() : Date.now();
  const at = (offsetSeconds: number) => new Date(start + offsetSeconds * 1000).toISOString();
  const ready = phase === 'Ready';
  const failed = phase === 'Failed';

  const trueAt = (offset: number): Pick<DeploymentCondition, 'status' | 'lastTransitionTime'> => ({
    status: 'True',
    lastTransitionTime: at(offset),
  });
  const pending = (): Pick<DeploymentCondition, 'status'> => ({ status: 'Unknown' });
  const falseAt = (
    offset: number,
    message: string,
  ): Pick<DeploymentCondition, 'status' | 'lastTransitionTime' | 'message'> => ({
    status: 'False',
    lastTransitionTime: at(offset),
    message,
  });

  const workload = ready ? trueAt(45) : failed ? falseAt(5, 'Failed to apply manifest work') : pending();
  const router = ready ? trueAt(15) : failed ? trueAt(5) : pending();
  const deploymentReady = ready ? trueAt(45) : failed ? falseAt(5, 'NotAsExpected') : pending();

  return [
    { type: 'DeploymentRequested', label: 'Deployment requested', ...trueAt(0) },
    {
      type: 'PresetsCombined',
      label: 'Presets combined',
      ...(ready || failed ? trueAt(5) : pending()),
    },
    {
      type: 'WorkloadsReady',
      label: 'Model workload',
      ...workload,
      children: [{ type: 'MainWorkloadReady', label: 'Main workload ready', ...workload }],
    },
    {
      type: 'RouterReady',
      label: 'Router / scheduler',
      ...router,
      children: [
        { type: 'GatewaysReady', label: 'Gateway ready', ...(ready || failed ? trueAt(5) : pending()) },
        {
          type: 'HTTPRoutesReady',
          label: 'HTTP routes ready',
          ...(ready ? trueAt(15) : failed ? trueAt(5) : pending()),
        },
      ],
    },
    { type: 'Ready', label: 'Deployment ready', ...deploymentReady },
  ];
};
