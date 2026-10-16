# PoC preset

The data the PoC (`krisv/ai-grid-cloud-provider-poc` at `62319b8`) shows, in the fake
backend's fixture format, so the console and the PoC can be compared screen by screen and
the browser tests find the PoC's names. `make dev-fake-poc` loads this directory; `make
dev-fake` still loads PR 12's fixtures in `mock/fixtures/`. The file shapes are the ones
`mock/fixtures/README.md` describes.

| File | What it seeds |
|---|---|
| `managedclusters.json` | The PoC's `seedClusters()` (`shared/grid-clusters.mjs`): `site1` San Francisco (`us-west`), `site2` New York (`us-east`), and `site3` Brussels (`europe-west`), AI Grid members and provisioned; `site4` Sydney (`asia-pacific`), not enrolled (no `ai-grid/enabled` label) and `ai-grid/provisioned: "false"`, the PoC's literal value. The `location` label is the cluster name. Everything else is copied from `mock/fixtures` `site-paris-1`, so all four read ready. Enrolling `site4` makes it a member that is still provisioning, so it doesn't become a location. |
| `models.json` | The PoC's three catalog models, `granite-3-8b` (Granite 3.3 8B Instruct), `llama-3-70b` (Llama 3.3 70B Instruct), and `granite-research` (Granite research endpoint), with no description, as CPU models on the hub with no placement: Ready at start, no locations. |
| `tenants.json` | The three organizations the UAT seeds into the PoC: `acme-robotics`, `globex-research`, and `initech-labs`, with their domains and identity providers, a creation time, and version 1. |
| `subscriptions.json` | The PoC's subscriptions `engineering`, `data-science`, and `research` with its groups, models, and token limits, and their authorization policies. Each belongs to one organization (`acme-robotics`, `globex-research` and `initech-labs`), as the form requires. All three read Active. |
| `settings.json` | No latency, speed 1, ManifestWorkReplicaSet gate on. |
| `access.json`, `presets.json` | Copies of `mock/fixtures`. |

There's no `scenarios.json`, so nothing changes over time.

`bff/internal/fakebackend/preset_test.go` checks this directory against the PoC and runs
PR 12's fixture checks on it, and `TestDemoMetricsMatchThePoC` checks that its members are
the input of `mock/golden/demo-metrics.json`. This directory mirrors the PoC at `62319b8` and the port's fixtures from before the rebase onto PR 12; when
it changes, keep the organizations and subscriptions in step with those two sources. All names, ids, and hosts are fictional.
