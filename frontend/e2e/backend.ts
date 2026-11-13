import { expect, type APIRequestContext, type Page } from '@playwright/test';

/**
 * The toast that says a Models or Subscriptions write is in Git, such as "Model <name> saved to
 * Git": the notification center says it when the backend answers, within the form's wait
 * (FORM_WAIT_MS) or after it. An error or a warning matches nothing here.
 */
export const writeConfirmed = (page: Page, title: string) =>
  page.getByRole('heading', { name: `Success alert: ${title}`, exact: true });

// Setup and cleanup the browser specs do on the backend's own API, through the console's origin and
// the BFF's Connect relay, as the browser's client calls it. The specs assert on the pages, not on
// these calls.

/**
 * The id Subscriptions/Create answers for the next create the page sends: the requested id, or that
 * id with a suffix on a backend that makes subscription names unique (backend PR 89). Start it
 * before the click that creates; it resolves to undefined when the create fails.
 */
export const createdSubscriptionId = (page: Page): Promise<string | undefined> =>
  page
    .waitForResponse((r) => r.url().includes('/ai_grid.v1.Subscriptions/Create'))
    .then(async (r) => (r.ok() ? ((await r.json()) as { object?: { id?: string } }).object?.id : undefined));

/** One Connect unary call; fails the test unless the backend answers 200. */
export const callBackend = async <T>(request: APIRequestContext, procedure: string, body: unknown): Promise<T> => {
  const res = await request.post(`/ai_grid.v1.${procedure}`, {
    data: body,
    headers: { 'Connect-Protocol-Version': '1' },
  });
  expect(res.ok(), `${procedure}: ${res.status()} ${await res.text()}`).toBeTruthy();
  return (await res.json()) as T;
};

/** The same call for cleanup: whatever the backend answers (the object may already be gone). */
export const tryBackend = async (request: APIRequestContext, procedure: string, body: unknown): Promise<void> => {
  await request.post(`/ai_grid.v1.${procedure}`, { data: body, headers: { 'Connect-Protocol-Version': '1' } });
};

/**
 * Commits a model to the backend's Git catalog (the UI_API_REFERENCE's minimal one), placed on
 * the first fixture cluster: git mode requires a placement, and checks only that it names a
 * ManagedCluster (checkPlacementClusters, internal/servers/models_server.go).
 */
export const createModel = async (request: APIRequestContext, id: string, displayName: string): Promise<void> => {
  const { items } = await callBackend<{ items: { id: string }[] }>(request, 'Clusters/List', {});
  await callBackend(request, 'Models/Create', {
    object: {
      id,
      metadata: { name: id, annotations: { 'openshift.io/display-name': displayName } },
      spec: {
        // No served name: the backend serves a model as its id and refuses any other name
        // (normalizeServedName, internal/servers/models_git.go at backend 1141af0).
        model: { uri: 'hf://facebook/opt-125m' },
        replicas: 1,
        main: { image: 'quay.io/example/vllm:latest', requests: { cpu: '100m', memory: '1Gi' } },
        placement: { labelSelector: { matchExpressions: [{ key: 'name', operator: 'In', values: [items[0].id] }] } },
      },
    },
  });
};
