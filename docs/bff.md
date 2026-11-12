# The BFF

The console is a React and PatternFly frontend served by a thin Go backend-for-frontend (BFF,
`bff/`), in one pod per ACM hub with kube-auth-proxy and
[ai-grid-provider-backend](https://github.com/ai-grid-cloud/ai-grid-provider-backend), the
provider API. The BFF does transport only (the root `AGENTS.md`;
[ADR-0004](adr/0004-the-bff-is-a-thin-relay.md)): it serves the frontend, checks who calls,
relays the browser's Connect calls to the backend and its Perses calls to the hub's Perses, and
answers for the console's own configuration and health. Everything that touches the hub's
resources, Keycloak or Git is the backend's.

```
browser --Connect /ai_grid.v1.*--> kube-auth-proxy --> BFF relay --> backend :9090 --> hub API, Keycloak, Git
browser --/perses/api----------->  kube-auth-proxy --> BFF relay --> the hub's Perses
browser --/api/v1/user, /config-> kube-auth-proxy --> BFF        (SelfSubjectAccessReview on the hub)
```

## Decisions

| Topic | Decision | Why |
|---|---|---|
| Language | Go, standard library `net/http` router. The BFF compiles against no contract: the Connect relay forwards bytes, and its one gRPC call of its own, the readiness probe, is the standard gRPC health service whose client ships with `google.golang.org/grpc`. No `client-go`, no backend module dependency. | The BFF reads nothing from the hub; its one Kubernetes call is a `SelfSubjectAccessReview` over plain HTTPS (`internal/hub`). Nothing to keep in step with the backend's proto, which the frontend is generated from (`docs/connect.md`). |
| Identity | kube-auth-proxy authenticates the browser and sets `x-forwarded-user`, `x-forwarded-email`, `x-forwarded-groups` and `x-forwarded-access-token`. The BFF reads them (`internal/identity`) and forwards the token as `Authorization: Bearer` plus the user, email and groups (`x-forwarded-user`, `x-forwarded-email` and `x-forwarded-groups`, the groups joined with `,`) on every call the Connect relay passes to the backend (`internal/relay`; the names are `internal/backend`'s). The BFF's own gRPC call, the readiness probe, is made for no caller and carries none. The backend reads these headers as gRPC metadata, whose values must be printable ASCII, and an OpenShift user or group name need not be, so the BFF percent-encodes each value (each group on its own, before the join): `%` and every byte outside 0x20–0x7E become `%XX` with upper-case hex, and nothing else changes, so an ASCII value without `%` is sent byte for byte (`équipe-ops` is sent as `%C3%A9quipe-ops`, `100%` as `100%25`). The proposed decoding, not yet agreed with the backend team: split the groups on `,`, then percent-decode each value (Go: `url.PathUnescape`, which leaves `+` alone) to get the UTF-8 name back. The backend doesn't decode yet, so it sees a non-ASCII name still encoded (an ASCII name without `%`, the usual case, is unchanged either way). These values are advisory: the backend reads nothing of them yet (it has no authentication, ADR-0004). | The backend decides what the caller may do, and the BFF has no credential of its own. Until the backend authorizes the caller, the BFF makes one decision itself: only a provider admin (see `isProviderAdmin`) reaches `/api/v1` beyond `GET /user` and `GET /config`, the Connect relay and the Perses relay; others get 403 (`AGENTS.md`, known exceptions). The proxy's provider can change (OpenShift OAuth today, a Keycloak realm later) without touching the BFF. |
| `isProviderAdmin` | The hub's answer to a `SelfSubjectAccessReview` for `post` on the non-resource URL `/ai-grid/provider-console`, asked with the caller's own token (`HUB_API_URL`, in-cluster by default). The chart's ClusterRole `ai-grid-provider-admin` grants it, and so does any role with a `*` nonResourceURLs rule for `post` (or every verb), such as cluster-admin; `oc auth can-i post /ai-grid/provider-console --as=<user> [--as-group=<group>]` checks a user (`charts/ai-grid-provider-console/README.md`, "Provider admins"). | The user's RBAC decides, not a console setting (review of 2026-10-15). The right is the console's own: ACM grants `patch` on ManagedClusters, the earlier check, to every authenticated user, and OpenShift's `cluster-reader` may `get` every non-resource URL, hence `post`. The UI uses it to show or hide actions, and until the backend authorizes the caller the BFF also refuses non-admins with it (see Identity). A `GetCurrentUser` RPC can take this over once the backend acts as the caller. |
| Login in development | The Vite dev server and `hack/api.sh` set the same headers from `oc whoami` and `oc whoami -t`; `make dev-fake` sets a fixture token the backend's fake hub knows. `make dev-cluster` forwards the backend of the console deployed on the hub (`hack/forward-backend.sh`); `make dev` uses one run from the backend repository. | Any developer who has run `oc login` works against a real hub, and anyone else on the backend's fakes. |
| Deployment | One pod: kube-auth-proxy (:8443), bff on `127.0.0.1:8080`, ai-grid-backend on `127.0.0.1:9090`. The BFF dials the backend in plaintext over loopback; plaintext to any other address is refused unless `BACKEND_INSECURE=true`. The kubelet probes `/readyz` through the proxy (`--skip-auth-route=^/readyz$`); neither the BFF nor the backend has a probe of its own. The rollout strategy is `Recreate`: the backend serializes each organization's writes with in-process locks (ai-grid-cloud/ai-grid-provider-backend#16), which hold only with one backend, so an upgrade stops the pod before the new one starts and the console is unavailable until it's ready. That covers rollouts only, not a pod deleted by hand or evicted. Client-side `kubectl apply` and `helm upgrade` switch an existing Deployment to `Recreate`; server-side apply refuses it while the defaulted `rollingUpdate` is there. | Nothing on the pod network can reach the BFF with forged identity headers or the backend at all. When the backend gets its own Deployment, set `BACKEND_ADDRESS` to its Service and `BACKEND_CA_FILE` to its serving CA. |
| Response envelope | The BFF's own JSON (`/api/v1`): success `{"data": ...}`, error `{"error": {"code": "<http status>", "message": "..."}}`. On the Connect relay the BFF's own refusals are Connect errors instead, and on the Perses relay, the caller checks' 401, 403 and 502 included, Perses's own error shape, `{"message": "..."}`: the Perses components show a failed query's message only from a string field, so the envelope's `error` object reached a panel as `[object Object]`. | Same as the odh-dashboard BFFs. |
| Tests | `httptest` against an in-memory backend (`internal/backend/backendtest`, gRPC over `bufconn`) and a stub hub; the golden responses in `mock/examples` (`make -C bff golden`) record the BFF's own JSON, which the frontend's tests and `hack/check-chart.sh` read. | No cluster, no binaries; the relay's tests record what reaches the backend, so identity forwarding is tested. `hack/smoke.sh` checks a live backend, and the browser tests run the real backend on its fakes. |

## Modules

```
bff/
  cmd/                  flags, server start and graceful stop
  internal/config       flags and env vars
  internal/identity     Identity from proxy headers, context helpers
  internal/hub          the provider-admin SelfSubjectAccessReview
  internal/backend      the backend's address and TLS rules, its gRPC health client, the identity header names; backendtest/ its test double
  internal/relay        reverse proxy for the browser's Connect calls to the backend (/ai_grid.v1.*)
  internal/perses       reverse proxy for the Monitoring page's calls to the hub's Perses
  internal/api          App, routes, middleware, error mapping, handlers, SPA
  internal/examples     the golden responses in mock/examples
```

Each setting is a flag with an environment variable as its fallback (`--port`, `PORT`); a flag
given on the command line wins. A variable whose value does not parse (`PORT=8o80`) stops the
BFF at startup with an error naming it, unless its flag was given (`PORT=8o80 bff --port=9000`
listens on 9000). `docs/dev-setup.md`, "BFF settings", lists them.

Adding an endpoint: don't. A new page calls the backend's own RPC over Connect, through the
relay, after the RPC is reviewed for the relay's allowlist (the root `AGENTS.md`, "Adding a
feature", and `docs/connect.md`). Validation, defaults, versions, filtering and derived fields
belong to the backend (the root `AGENTS.md`, which also lists the exceptions the BFF still has).
**The backend must therefore validate every write RPC before that RPC goes live behind the
console:** the relay forwards the bytes it gets, and a page's inline messages are no protection.

## Endpoints

| Method | Path | Returns | Backend |
|---|---|---|---|
| GET | `/healthcheck` | `{status, version}` | none; no identity and no backend call: a check, by a person or a script on the pod, that the BFF process serves HTTP and which build it is (`version`). No probe uses it: the kubelet probes only `/readyz` (below), and there is deliberately no liveness probe, which would restart the BFF whenever the proxy in front of it is down. Through the route it is behind the login like any page (the proxy skips auth for `/readyz` only) |
| GET | `/readyz` | `{status, version, backend}` | `grpc.health.v1.Health/Check` with no service name, the standard gRPC health service the backend registers for every service it serves; readiness, 503 when the backend does not answer or answers anything but `SERVING`. The pod is then unready, and with the one replica the chart runs, the Service has no endpoint left: the OpenShift router answers every request with its own 503 page (HTML, not this API's JSON error), until the backend answers again |
| GET | `/api/v1/user` | `{username, email?, groups, isProviderAdmin}` (`email` omitted when the proxy sends none) | none; the identity from the proxy headers, `isProviderAdmin` from a hub `SelfSubjectAccessReview` |
| GET | `/api/v1/config` | `{gridEndpoint, mapTileUrl, mapTileAttribution, billingUrl, version, fakeBackend, monitoring: {enabled, persesProject}, models: {hardware}}`: `fakeBackend` says the backend runs on fake infrastructure (`make dev-fake`, the browser tests), so the UI shows its fake-backend banner and, with no login proxy, keeps an ended session on the page instead of sending it to sign in; `monitoring.enabled` says the BFF relays `/perses/api` (it has a `PERSES_URL`) and `monitoring.persesProject` names the one Perses project the relay reads, whose `dashboard-*-admin` objects are the Monitoring tabs (always set when `monitoring.enabled`); `models.hardware` is the Deploy model wizard's Hardware list, never empty, each `{id, label, description?, accelerator?, image?, env?, defaults?: {accelerators?, cpu?, memory?}}` (see "Model hardware" below) | none; env `GRID_CONSUMER_URL`, `MAP_TILE_URL`, `MAP_TILE_ATTRIBUTION` (the attribution shown with `MAP_TILE_URL`'s tiles; with no `MAP_TILE_URL` the map draws a bundled land outline), `BILLING_URL`, `FAKE_BACKEND`, `PERSES_URL`, `PERSES_PROJECT`, `MODEL_HARDWARE` |
| GET, POST | `/perses/api/<Perses API path>` | Perses's own answer, status and body unchanged, with only its `Content-Type`, `Content-Encoding`, `Content-Length`, `Vary`, `Cache-Control`, `Date`, `Age` and `Expires` headers; a redirect from Perses is 502 | none; the Monitoring page's relay to the hub's Perses (`PERSES_URL`), see "The Perses relay" |
| GET, POST | `/ai_grid.v1.<Service>/<Method>` | The backend's own answer, with only the headers a Connect client needs | the procedure itself, if the relay's allowlist has it; see "The Connect relay" |
| GET | every other path | the built frontend (`STATIC_ASSETS_DIR`), `index.html` for a client route | none |

## Headers, caching and compression

- **The SPA** (every path outside `/api`, `/perses/api`, `/ai_grid.v1.*`, `/healthcheck` and `/readyz`:
  `index.html`, the client routes that fall back to it, and the files under `/assets/`) is
  sent with `X-Frame-Options: DENY`, `X-Content-Type-Options: nosniff`,
  `Referrer-Policy: same-origin` and this `Content-Security-Policy` (`pagePolicy` in
  `bff/internal/api/static.go`, which says why each directive allows what it does):
  `default-src 'self'; script-src 'self'; style-src 'self' 'unsafe-inline'; img-src 'self'
  data:; font-src 'self'; connect-src 'self'; object-src 'none'; base-uri 'none'; form-action
  'self'; frame-ancestors 'none'`. The bundle's own files are the only scripts: no inline
  script, inline event handler, `javascript:` URL or eval, so markup a component puts into a
  page cannot run script; no plugins, no `<base>`, no form posting off the console. Inline
  styles are allowed because the Monitoring page's Perses components insert `<style>` elements;
  `data:` images for the empty favicon. When `MAP_TILE_URL` names a tile server, its scheme,
  host and port (a `{s}` first label as `*.`) join `img-src`; the BFF refuses to start with a
  tile URL that is neither a path on the console nor an `http(s)` URL of a host name. The
  console must not be framed by any page, including another app under the cluster's `*.apps`
  domain: that is same-site, so `SameSite=Lax` on the proxy's cookie does not stop it.
  kube-auth-proxy and the Route pass the header through unchanged. Every browser spec loads its
  pages from the BFF and fails on any violation (`frontend/e2e/fixtures.ts`).
- **Caching.** Every file under `/assets/` is `Cache-Control: public, max-age=31536000,
  immutable`: Vite writes only content-hashed names there (`index-BPyNsiKc.css`, with
  base64url hashes), so a new build has new URLs. `index.html`, the client routes and the
  other root files (the favicon) are `no-cache`, so a browser revalidates them and picks up a
  new bundle at once.
- **The JSON API** answers carry `Content-Type: application/json`, `X-Content-Type-Options:
  nosniff` and `Cache-Control: no-store`, but no CSP: they are not pages. `/perses/api` answers
  keep the headers the relay sets.
- **Compression.** Every answer, the API, the SPA and the relay alike, is gzipped
  (`Content-Encoding: gzip`, no `Content-Length`) when the request's `Accept-Encoding` accepts
  gzip (RFC 9110 12.5.3: a `gzip` entry decides with its q, `*` counts only when `gzip` is
  not listed, a q of 0 or one that does not parse refuses), its type is `text/html`, `text/css`,
  `application/javascript`, `text/javascript`, `application/json` or `image/svg+xml`, and the
  body is 1 KiB or more. It is sent as it is for a `HEAD`, a request with `Range` (the ranges
  are of the uncompressed file), a 204 or 304, and an answer that already has a
  `Content-Encoding` (Perses's own gzip passes through the relay unchanged). Answers of those
  types carry `Vary: Accept-Encoding`. A handler that flushes (the relay streaming an answer)
  sends each part as it flushes, compressed, without waiting for the end.
- **A panic** in a handler is logged with its stack (`panic serving request`). Before anything
  was sent it answers a plain JSON 500. Once the status was sent (a gzip stream started, a part
  flushed), the connection is cut instead, without a gzip trailer: a 500 written into an answer
  under way would leave the client a body it cannot decode, or one that looks complete.

## Logs

One `request` line per request (method, path, status, duration) with `id`, the `X-Request-Id`
the client also gets, and `user`, the forwarded user name, once the proxy headers have been
read (never the token). `request failed` carries the same `id` and `user`, so the log says
which admin asked what. Every write goes through the Connect relay, whose log lines name the
procedure. A successful `/readyz` or
`/healthcheck` logs at Debug; a failed one stays at Info (and `backend not ready` at Warn).
`request failed` (Error) is for a 5xx other than 501. A 501, which a backend without the RPC
or option answers and the frontend shows as not available yet, logs its detail at Debug, as a
4xx does (`request rejected`); its `request` line still says `status=501`.

## Model hardware

`models.hardware` in `/api/v1/config` is console configuration, like the map's tiles: the
choices the Deploy model wizard offers, which the provider admin sets in the chart's
`console.models.hardware` (`charts/ai-grid-provider-console/README.md`, "Model hardware"). The
chart renders it as `MODEL_HARDWARE`, a JSON list. The defaults live in the chart's `values.yaml`:
**NVIDIA GPU** (`nvidia.com/gpu`, one GPU, CPU 2, memory 16Gi,
no image: the cluster's default vLLM image for NVIDIA GPUs) and **CPU only** (OpenShift AI 3.6's
vLLM CPU image with `VLLM_CPU_KVCACHE_SPACE=4` and `OMP_NUM_THREADS=4`, CPU 4, memory 8Gi).
`MODEL_HARDWARE` empty or unset (a local run, `make dev`, or the chart with an empty list) falls
back to the BFF's copy of the same two, `config.DefaultModelHardware`; `hack/check-chart.sh` fails
when the chart's defaults differ from it, as `mock/examples/get-config.json` records it. The BFF
reads the list strictly at start and doesn't start when an entry breaks a rule `values.schema.json`
also checks: an unknown field, an id that isn't a DNS label or is used twice, an empty label (Unicode spaces count), an
accelerator that isn't a Kubernetes extended resource name (a domain, a slash and a name, without kubernetes.io/), an image with whitespace, an environment
variable that isn't a valid name or is `VLLM_ADDITIONAL_ARGS` (the wizard's runtime arguments),
`defaults.accelerators` outside 1 to 64 or without an accelerator, and a `defaults.cpu` or
`defaults.memory` the wizard doesn't take. It decides nothing about a model: the wizard sends an
entry's image, environment and resources in `Models/Create`, and the backend validates them.

## The Perses relay

The Monitoring page embeds the hub's Perses dashboards the way the OpenShift AI dashboard's
Observability page does (odh-dashboard `packages/observability`): the browser calls only
`/perses/api`, and the server forwards the call with the user's own token
(`bff/internal/perses`). It is transport like the rest of the BFF. Perses authenticates the token
and authorizes each project (the Cluster Observability Operator's Perses uses Kubernetes authn
and authz: projects are namespaces), and its datasource proxy runs the queries.

**Where the caller's token goes.** The token reaches Perses, and does not stop there. With
Kubernetes authorization, Perses's datasource proxy sends the caller's `Authorization` header
unchanged to the datasource's URL (perses `internal/api/impl/proxy`,
`forwardCallerAuthorization`). So a query through a datasource hands a provider admin's hub token
to whatever server that datasource names, and whoever can write the datasource chooses that
server. That is why the relay reads one project, `PERSES_PROJECT` (required with `PERSES_URL`),
and the global datasources, and nothing else: not every project's dashboard list, not another
project, and not a datasource that a dashboard defines inside itself. The relay can't check
where a datasource points, so the operator must make sure that only provider admins can write
that project's dashboards and datasources, and that the global datasources point only at the
hub's own Thanos and Loki.

What the relay owns is the boundary:

- Only the provider-admin check's callers pass, as on `/api/v1` (401 without a token, 403 for a
  non-admin, 502 when the hub can't answer the check, each as `{"message": "..."}`), until Perses or the backend can tell provider views from tenant ones: an
  organization admin must never reach the provider dashboards.
- Only the reads the Perses React components make, in the configured project `{P}`:
  `GET /api/v1/projects/{P}/dashboards[/{d}]`, `/api/v1/projects/{P}/datasources[/{d}]`,
  `/api/v1/globaldatasources[/{d}]`, and the Prometheus and Loki query APIs behind those
  datasources' proxies (`/proxy/projects/{P}/datasources/{d}/api/v1/query…`,
  `/proxy/globaldatasources/{d}/…`). Any other path is 404, `/api/v1/dashboards`, another
  project and `/proxy/projects/{P}/dashboards/{d}/datasources/…` included; a method other than
  `GET` is 405, except `POST` on a query path, which the Prometheus plugin sends as a form
  (`application/x-www-form-urlencoded`, else 415; at most 1 MiB, else 413). A path with an
  encoded slash, a dot segment or a doubled slash is 404, so Perses never sees another path than
  the one checked. `PERSES_PROJECT` must itself be one path segment of letters, digits, `-`, `_`
  and `.`, or the BFF doesn't start.
- Only `Accept`, `Accept-Encoding`, `Accept-Language`, `Content-Type` and `Authorization: Bearer
  <the caller's token>` reach Perses: no cookies, no proxy identity headers, no client-sent
  `Authorization`. With the browser's `Accept-Encoding`, a compressed answer passes through as
  Perses sent it.
- Only Perses's `Content-Type`, `Content-Encoding`, `Content-Length`, `Vary`, `Cache-Control`,
  and the `Date`, `Age` and `Expires` a cache needs to tell how fresh an answer is, reach the browser, plus the relay's own `X-Content-Type-Options: nosniff` and a sandbox
  `Content-Security-Policy`. Everything else stays behind: a `Set-Cookie` for the console's origin,
  a CORS grant (the console reads these answers from its own origin, so it would only open them to
  other sites), a datasource's `WWW-Authenticate` challenge (the browser would ask for a password on
  the console's origin), and a `Refresh` or `Link` that would send the browser elsewhere. A 3xx
  from Perses is 502 "the hub's Perses answered with a redirect, which the console doesn't follow",
  so its `Location` never reaches the browser either; the relay sends no conditional request, so
  Perses has no reason to answer 304.
  Nor do an informational answer (a `103 Early Hints` and its `Link`) or trailers, which Go's
  reverse proxy forwards outside the final answer's headers.
- Without `PERSES_URL`, every `/perses/api` path is 404 "monitoring is not configured on this
  console" and `GET /config` says `monitoring.enabled: false`.

Settings: `PERSES_URL` (https; `http://` only for loopback unless `PERSES_INSECURE=true`),
`PERSES_CA_FILE` (the hub's service CA for the operator's Perses), `PERSES_SERVER_NAME` (for a
port-forward to `127.0.0.1`), `PERSES_TIMEOUT` (30s, at most 50s, for the exchange with Perses from connecting to the last byte of its answer: past it the relay answers 504, or cuts an answer already started; the ceiling keeps it, with the provider-admin check before it, inside the server's 60s write timeout, which also cuts a browser that stops reading),
`PERSES_PROJECT` (required with `PERSES_URL`). To turn Monitoring on in the hub pod, set
`PERSES_URL` to `https://perses.openshift-cluster-observability-operator.svc:8080`,
`PERSES_PROJECT`, and `PERSES_CA_FILE` to the service CA
(`/var/run/secrets/kubernetes.io/serviceaccount/service-ca.crt` in an OpenShift pod): the
operator's Perses has a service-CA certificate, so without the CA file the relay answers 502.
The chart sets them from `console.perses` (`url`, `project`, and `caFile`, which defaults to that
service CA), and fails to render with a `url` and no `project`; its default `url` is empty, as
`manifests/base` sets neither, so a deployed console has Monitoring off until its values set
`url`. `make dev-cluster` forwards that Service when `PERSES_PROJECT` is set and your login may
(`hack/forward-perses.sh`); without `PERSES_PROJECT` it runs with Monitoring off. A `PERSES_URL`
you set yourself without `PERSES_PROJECT` stops the BFF at startup.

What a dashboard needs to appear on the page, for the team that writes them:

- It is a `PersesDashboard` in `PERSES_PROJECT` (the chart's `console.perses.project`) whose name
  starts with `dashboard-` and ends with `-admin`, such as `dashboard-1-model-admin`. The prefix and
  the suffix are odh-dashboard's (`filterDashboards`): the prefix tells the dashboards meant as tabs
  from anything else kept in the project, and the suffix marks the variant for users with cluster-wide
  metrics access, which every provider admin has. A dashboard without the suffix is written for users
  scoped to their own projects or identity (OpenShift AI's `dashboard-1-model`, MaaS's
  `dashboard-5-maas-usage-logs`, My Usage, which needs a MaaS user) and is not a tab, whether or not it
  has an admin variant (`monitoringTabs`, `frontend/src/api/monitoring.ts`). The tab shows the
  dashboard's display name, or its name, and tabs are ordered by name.
- Its queries name a `PersesDatasource` in the same project or a `PersesGlobalDatasource` (by kind,
  or kind and name; one marked `default: true` is used when a query names only the kind), which
  reaches Prometheus or Loki through its `proxy`, not `directUrl`: the browser can't reach the
  hub's services. A datasource defined inside the dashboard itself fails in its panel.
- Its panels are among the bundled ones listed below.
- For a cluster's details, it defines hidden text variables named `CLUSTER_DETAILS_*`, as
  odh-dashboard reads them (`ClusterDetailsVariablesProvider`), and a `cluster_name` list
  variable whose values are ManagedCluster names (`frontend/src/pages/monitoring/clusterDetails.ts`).
  With one cluster selected, the console sets `CLUSTER_DETAILS_INFRASTRUCTURE_PROVIDER`,
  `CLUSTER_DETAILS_OPENSHIFT_VERSION` and `CLUSTER_DETAILS_API_SERVER` from that cluster's
  `platform.open-cluster-management.io`, `version.openshift.io` and `apiserverurl.openshift.io`
  claims in `Clusters/List`, and `CLUSTER_DETAILS_CHANNEL` to "Not available" (the hub doesn't
  know the OpenShift AI operator's channel). A claim the hub doesn't report, or a cluster it doesn't
  list, is "Not available"; All or several clusters are "Select one cluster". It sets only the
  `CLUSTER_DETAILS_*` variables a dashboard defines, and reads `Clusters/List` only for such a
  dashboard. Like every variable, the values also appear in the URL as `var-<name>`.
- Only provider admins may create or edit the `PersesDashboard`s and `PersesDatasource`s in that
  project and the `PersesGlobalDatasource`s: Perses sends the signed-in admin's hub token to every
  datasource it queries, so whoever can point a datasource somewhere can collect that token.

The page (`frontend/src/pages/monitoring`): with `monitoring.enabled`, `/monitoring` lists the
dashboards of `monitoring.persesProject` through the relay and shows each `dashboard-*-admin` one as a
tab, ordered by name and selected with `?dashboard=<name>`. A panel whose datasource the dashboard
defines itself shows an error in the panel instead of querying it. It renders the selected one with
Perses's own React components and the plugins bundled in `persesPlugins.ts` (Prometheus and
Loki datasources, queries and variables; static list variables, whose values the dashboard lists;
time series, stat, bar, table, gauge, pie and markdown panels), loaded with the page only. The bar
chart is patched (`frontend/patches`, pnpm's `patchedDependencies`) to escape names in its tooltip,
which ECharts renders as HTML: the category and series names and the marker color, as the pie chart
already does, until a Perses release does the same. Not the logs table: its package imports a
stylesheet it doesn't ship (`ansiColors.css`, missing from 0.4.0 and from 0.5.0-beta.0, the release
for Perses 0.56). Without
`monitoring.enabled`, `/monitoring` says Monitoring is not set up for this console and names the
chart's `console.perses.url` and `console.perses.project`, which a hub administrator sets; it
calls nothing.

## The Connect relay

Every page calls the backend's own RPCs from the browser over Connect, with clients generated
from the backend's proto (ADRs 0002 and 0004 in `docs/adr/`; the generated code and its pin in
`docs/dev-setup.md`, "The backend's API in the frontend"). The BFF relays those calls (`bff/internal/relay`): an `httputil.ReverseProxy` for the
paths under `/ai_grid.v1.`, to the backend at `BACKEND_ADDRESS`, which serves Connect, gRPC and
gRPC-Web on its gRPC port over HTTP/1.1 and h2c. It is transport and nothing else: it compiles
against no contract and never reads a body. A new RPC needs no transport implementation;
until backend authorization lands it requires review for the procedure allowlist. The Clusters
pages, the AI Grid map and the Models, Subscriptions and Organizations pages use it; the
`/api/v1` routes that remain only read and are the BFF's own (`/user`, `/config`).

What the relay owns is the boundary:

- **Who may call.** The same checks as `/api/v1`, before anything else: the token header (401
  without one), then the provider-admin check (401 for a token the hub rejects, 403 for a
  caller who isn't a provider admin, 502 when the hub can't answer). On these paths the BFF's
  own refusals are Connect errors, `{"code": "unauthenticated" | "permission_denied" | ..., "message"}`
  with the same HTTP status, which the browser's Connect client reads; the backend's own errors
  pass through as it sent them.
- **What reaches the backend about the caller.** Of the browser's request, `Authorization`,
  `Proxy-Authorization`, `Cookie`, `Forwarded`, every `X-Forwarded-*` and `X-Auth-Request-*`
  header and the configured `AUTH_*_HEADER`s are dropped (Go's reverse proxy also drops the
  hop-by-hop headers). Then the relay sets the caller as the BFF read them from the proxy's
  headers (`rewrite`, `internal/relay`):
  `Authorization: Bearer <token>`, and `x-forwarded-user`, `x-forwarded-email` and
  `x-forwarded-groups`, each percent-encoded and the groups joined with `,` (see Identity under
  "Decisions" above); a field the caller doesn't have is not sent. The rest of the request (the
  Connect headers such as `Connect-Protocol-Version` and `Connect-Timeout-Ms`, `Content-Type`,
  `Accept-Encoding`, the query of a Connect GET) passes unchanged.
- **Which calls.** Only a path `/ai_grid.v1.<Service>/<Method>` (letters, digits and `_`; no
  further segment, dot segment or escape), so the backend routes the path that was checked, and
  never its REST gateway, health or reflection on the same port: any other path under the
  prefix is 404 (`unimplemented`). The explicit allowlist permits the existing console
  operations: `AiGrid/Ping`, Clusters List/Get/Update, Tenants CRUD/List, Models CRUD/List
  and ListPlacementClusters, and Subscriptions CRUD/List (the Subscriptions pages, and the
  Models page's list of the subscriptions that use a model). Clusters Create/Delete, the
  deprecated `Models/ListLocations`, `Tenants/ListMembers`
  (the console never lists an organization's members: one organization is one tenant, and the
  provider must not see a company's internals), unknown services and future methods return 404
  until reviewed (AGENTS.md, "Known exceptions"). Only `POST` (Connect unary and streaming calls) and `GET`
  (Connect's GET, for methods the proto marks free of side effects): any other method is 405
  (`unimplemented`) with `Allow: GET, POST`, after the caller checks, as on `/api/v1`. Only the
  Connect protocol, the one the browser's client speaks: a POST's `Content-Type` must be
  `application/json` or `application/proto` (unary) or `application/connect+json` or
  `application/connect+proto` (streaming), parameters such as `charset` allowed; gRPC, gRPC-Web
  (which the backend also serves on that port) and anything else are 415 (`unimplemented`)
  before the backend is called. A GET needs none.
- **How much.** A body of at most 1 MiB, as for the JSON API: a declared larger one is 413
  (`resource_exhausted`) before the backend is called, an undeclared one is cut at 1 MiB with
  the same answer. Compressed requests (`Content-Encoding`, `Connect-Content-Encoding`,
  or GET `compression`) are refused with 415, so compression cannot bypass the decoded-size
  bound. Identity encoding remains allowed; response compression is unchanged.
- **How long.** A unary call (every GET, and a unary POST) is bounded by `BACKEND_TIMEOUT` (10s,
  at most 50s so that the 504 fits in the server's 60s write timeout), as an RPC from the BFF
  is: past it the relay answers 504 (`deadline_exceeded`). Every call, a stream included, waits
  at most `BACKEND_TIMEOUT` for the backend's headers (504 likewise). The procedures that change
  data take `BACKEND_WRITE_TIMEOUT` (30s, at most 50s) for both instead: the allowlist marks each
  procedure as a read or a write (`allowedProcedures`; today every `Create`, `Update` and
  `Delete`), and the relay decides by the path, never by the body. The backend commits Models and
  Subscriptions to a Git repository, which can take longer than a read, and a write the relay cut
  at the read timeout could still land, so its 504 would say nothing about the outcome (the
  console treats such a write as unknown and checks it, `docs/connect.md`, "Writes that take
  long"). The router and kube-auth-proxy in front of the BFF wait longer than its 60s server write
  timeout (the chart's `route.timeout`, 70s, and `authProxy.upstreamTimeout`, 65s; their defaults,
  30s, would cut a write first; `charts/ai-grid-provider-console/README.md`, "Timeouts").
  A stream whose headers came
  runs until it ends or the server's 60s write timeout cuts it, and reaches the browser as the
  backend flushes it; when the browser goes away, the backend's call is canceled. A backend that
  can't be reached, or whose certificate isn't trusted, is 502 (`unavailable`), with the detail
  in the BFF's log.
- **What comes back.** The backend's status and body as it sent them, and of its headers only
  `Content-Type`, `Content-Encoding`, `Content-Length`, `Accept-Encoding`, `Vary`,
  `Cache-Control`, `Date` and those starting with `Connect-`, `Grpc-` or `Trailer-` (a Connect
  unary call's trailers), plus the relay's own `X-Content-Type-Options: nosniff`. Anything else
  stays behind: a `Set-Cookie` for the console's origin, a CORS grant, a `WWW-Authenticate`
  challenge, a `Location` or `Refresh`, and the backend's say on the security headers. The BFF's
  gzip applies as to any answer: a unary JSON answer of 1 KiB or more is compressed, a stream
  isn't.
- **Where to.** The gRPC client's rules (`backend.Config.TLS`): plaintext to a loopback address
  (the pod's `127.0.0.1:9090`) or with `BACKEND_INSECURE=true`; HTTPS verified against
  `BACKEND_CA_FILE` (with `BACKEND_SERVER_NAME`) when it is set; no plaintext across the network
  otherwise.

kube-auth-proxy runs with `--api-route=^/ai_grid\.v1\.` (the chart, `manifests/base`), so a call
without a valid session on these paths is 401, not a redirect to the login page that `fetch`
can't follow; the frontend's transport (`frontend/src/api/connect/transport.ts`) then asks the
console to check its session, as a 401 from the Perses relay does. The Vite dev server proxies
the same paths to the BFF. Try it without a cluster with `make dev-fake` (`docs/dev-setup.md`),
the backend at `.backend-api-version` on its own fake hub and Keycloak.

```sh
curl -s -H 'x-forwarded-access-token: dev-token' -H 'x-forwarded-user: dev-user' \
  -H 'Content-Type: application/json' -d '{"limit":2}' \
  http://127.0.0.1:8080/ai_grid.v1.Clusters/List
```

## Errors

The BFF maps no backend error to a status of its own: its one gRPC call, the readiness probe,
answers 503 from `/readyz` when it fails, and the Connect relay passes the backend's own errors
through.

| Situation | Status |
|---|---|
| A path under `/api/v1` that no route has | 404, `the requested resource could not be found` |
| A known `/api/v1` path with a method it has no route for (`POST /config`) | 405 with `Allow` (`GET, HEAD`; a GET route also answers HEAD) and the JSON error shape, `POST is not allowed on /api/v1/config; use GET, HEAD`. It is checked after the identity and provider-admin checks, so a non-admin gets 403 on any path but `GET /user` and `GET /config` |
| Missing or malformed token header | 401 |
| Hub rejects the token in the access review | 401 |
| Hub unreachable, failing or slower than 5 s during the access review | 502, `the hub could not confirm the caller's permissions; try again`, detail in the BFF log (a slow hub is not the backend's 504) |
| The access review says the caller is not a provider admin (may not post to `/ai-grid/provider-console`): every `/api/v1` request but `GET` (or `HEAD`) `/user` and `/config` (the provider-admin check, until the backend authorizes the caller) | 403, `this console is only for provider admins, users the hub's ai-grid-provider-admin role allows, and the hub says you are not one` |
| `/perses/api` without `PERSES_URL`, or a Perses path the relay does not pass | 404, BFF message |
| `/perses/api` with a method other than `GET` (or `POST` on a query path) | 405, `the console reads Perses only` |
| `/perses/api` query `POST` not declared `application/x-www-form-urlencoded` | 415, BFF message |
| Perses unreachable or its certificate untrusted; Perses slower than `PERSES_TIMEOUT` | 502, `the hub's Perses could not be reached; try again`; 504, `the hub's Perses did not answer in time`. Like the relay's other refusals, as `{"message": "..."}`, which a panel shows |
| Any answer from Perses (its 401, 403 and 404 included) | Perses's status and body unchanged |
| `/ai_grid.v1.*` without a token, with one the hub rejects, from a caller who isn't a provider admin, or with the hub unreachable | 401, 401, 403, 502 as on `/api/v1`, as a Connect error (`unauthenticated`, `permission_denied`, `unavailable`) |
| `/ai_grid.v1.*` path that is not `/ai_grid.v1.<Service>/<Method>`; a method other than `POST` and `GET` | 404, 405 with `Allow: GET, POST`; Connect error `unimplemented` |
| `/ai_grid.v1.*` body over 1 MiB | 413, Connect error `resource_exhausted` |
| `/ai_grid.v1.*` POST that is not the Connect protocol (gRPC, gRPC-Web, any other `Content-Type`) | 415, Connect error `unimplemented` |
| `/ai_grid.v1.*` backend unreachable or untrusted; a unary call slower than `BACKEND_TIMEOUT` (`BACKEND_WRITE_TIMEOUT` for a write procedure), or any call whose headers take longer | 502 `unavailable`; 504 `deadline_exceeded` |
| Any answer from the backend on `/ai_grid.v1.*` (its Connect errors included) | the backend's status and body unchanged, with only the headers a Connect client needs |

## Out of scope for the BFF

- No Kubernetes client and no hub resources. The backend owns them. The one exception is
  the `SelfSubjectAccessReview` behind `isProviderAdmin`, which asks the hub about the
  caller with the caller's own token and reads nothing.
- No session handling. The proxy owns login and cookies.
- No billing data. Nothing in the platform stores it (confirmed 2026-10-14) and
  whether AI Grid gets a cost or spend view is an open product question. `billingUrl` in
  `/api/v1/config` is a plain external link that stays empty until a page exists.
- No metering. Praxis AI's `external_metering` filter emits CloudEvents to a metering
  service; nothing on the dev hub receives them yet.
- No OSAC integration in this round; the backend is the OSAC-like layer.
