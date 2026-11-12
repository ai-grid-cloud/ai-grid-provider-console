import { describe, expect, it } from 'vitest';
import type { ClusterView } from './clusterView';
import { canSetRole, labelsUpdate, settingsErrors, settingsOf } from './gridSettings';

/** The parts of a ClusterView the edit reads. */
const view = (labels: Record<string, string>) => ({ name: 'site-a', labels, version: 7 }) as ClusterView;

describe('settingsOf', () => {
  it('reads the role and the location label, trimmed', () => {
    expect(settingsOf(view({ 'ai-grid/role': 'combined', location: ' eu-west ' }))).toEqual({
      role: 'combined',
      location: 'eu-west',
    });
  });

  it('reads a role that is not one of the three as none, which Edit may set', () => {
    const odd = view({ 'ai-grid/role': 'gateway' });
    expect(settingsOf(odd).role).toBe('');
    expect(canSetRole(odd)).toBe(true);
    expect(canSetRole(view({}))).toBe(true);
    expect(canSetRole(view({ 'ai-grid/role': 'inference' }))).toBe(false);
  });
});

describe('settingsErrors', () => {
  it('requires a role and a location label that is a label value', () => {
    expect(settingsErrors({ role: 'ingress', location: 'eu-west' })).toEqual({});
    expect(settingsErrors({ role: '', location: '' })).toEqual({ role: 'Required', location: 'Required' });
    expect(settingsErrors({ role: 'ingress', location: '-eu' }).location).toMatch(/^Must start and end with a letter/);
  });
});

describe('labelsUpdate', () => {
  const member = view({ 'ai-grid/enabled': 'true', 'ai-grid/role': 'ingress', location: 'eu-west', team: 'blue' });

  it('changes nothing for the settings as read, whitespace included', () => {
    expect(labelsUpdate(member, settingsOf(member))).toBeUndefined();
    expect(labelsUpdate(member, { role: 'ingress', location: ' eu-west ' })).toBeUndefined();
  });

  it('sends the labels as read with the location label changed', () => {
    expect(labelsUpdate(member, { role: 'ingress', location: ' eu-central ' })).toEqual({
      'ai-grid/enabled': 'true',
      'ai-grid/role': 'ingress',
      location: 'eu-central',
      team: 'blue',
    });
  });

  it('never changes the role a cluster has, whatever the form holds', () => {
    expect(labelsUpdate(member, { role: 'inference', location: 'eu-west' })).toBeUndefined();
    expect(labelsUpdate(member, { role: 'combined', location: 'eu-central' })?.['ai-grid/role']).toBe('ingress');
  });

  it('sets the role of a cluster without one, or with a value that is not a role', () => {
    expect(
      labelsUpdate(view({ 'ai-grid/enabled': 'true', location: 'x' }), { role: 'combined', location: 'x' }),
    ).toEqual({
      'ai-grid/enabled': 'true',
      'ai-grid/role': 'combined',
      location: 'x',
    });
    expect(
      labelsUpdate(view({ 'ai-grid/role': 'gateway', location: 'x' }), { role: 'inference', location: 'x' }),
    ).toEqual({ 'ai-grid/role': 'inference', location: 'x' });
  });

  it('leaves the cluster as read untouched', () => {
    labelsUpdate(member, { role: 'ingress', location: 'eu-central' });
    expect(member.labels.location).toBe('eu-west');
  });
});
