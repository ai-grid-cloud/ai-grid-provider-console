// The BFF's JSON under PR 12's fixtures (mock/examples), served to HttpConsoleService, so page
// tests render what the browser gets from `make dev-fake` instead of the mock's own shapes.
import getModels from '../../../mock/examples/get-models.json';
import { HttpConsoleService } from '../api/HttpConsoleService';
import { MockConsoleService } from '../api/MockConsoleService';

const json = (data: unknown) =>
  new Response(JSON.stringify({ data }), { headers: { 'Content-Type': 'application/json' } });

/** Answers GET /models and /locations with PR 12's fixture JSON. */
export const pr12Fetch = () =>
  vi.fn(async (url: string, init?: RequestInit) => {
    if (init?.method === 'DELETE') return new Response(null, { status: 204 });
    if (url.endsWith('/models')) return json(getModels.body.data);
    if (url.endsWith('/locations')) return json(['paris']);
    return new Response(JSON.stringify({ error: { message: `unexpected ${url}` } }), { status: 404 });
  });

/** A MockConsoleService whose models come from PR 12's JSON through HttpConsoleService. */
export const serviceOnPr12Json = (fetchFn: ReturnType<typeof pr12Fetch> = pr12Fetch()) => {
  const service = new MockConsoleService();
  const http = new HttpConsoleService(fetchFn as unknown as typeof fetch);
  service.listModels = () => http.listModels();
  service.listLocations = () => http.listLocations();
  return service;
};
