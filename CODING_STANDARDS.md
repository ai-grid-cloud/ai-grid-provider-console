# Coding standards

Read during **review**, not implementation. Only judgement calls live here: anything a check
can decide belongs in a check instead.

| Decided by a check, not this file | Where |
|---|---|
| Go formatting, vet, lint | `make -C bff vet lint`, `golangci-lint` in CI |
| TypeScript lint, formatting, types | `pnpm lint`, `format:check`, `typecheck`; all in CI |
| Generated code is in step with its source | `make -C bff check-generated` |
| A `buf.validate` pattern actually constrains anything | `bff/internal/contractguard` |
| Observable behaviour is unchanged | `make e2e` — the Playwright specs, which assert on visible text only |

Use the vocabulary in [GLOSSARY.md](GLOSSARY.md), and check [docs/adr/](docs/adr/) before
objecting to a decision that looks surprising.

## Protobuf

**Generic names are a one-way door.** `ai_grid.v1` is flat, so every top-level message claims
an unqualified slot forever: the repo's buf config sets `breaking: FILE`, which makes renaming
after release a breaking change. A type only one resource composes takes that resource's
prefix — `ModelPlacement`, `GridMetric` — while a faithful upstream Kubernetes or ACM shape
another resource would reference in the same form keeps upstream's name: `LabelSelector`,
`Toleration`, `EnvVar`. Challenge any new bare noun: `Owner`, `Placement`, `Metric`, `Status`.

**One representation per concept, across the whole contract.** A response carrying a
`google.protobuf.Timestamp` beside an `int64` of epoch seconds makes the client parse two time
formats for one payload. Same for durations, identifiers and references. Check what the
neighbouring field does before inventing a shape.

**References are typed messages, never bare strings.** A `string model_name` loses the
namespace and cannot be validated; a `ModelRef` carries both and says what it points at.

**An update mask that omits a mutable field is a silent dead end.** List every path the server
accepts, and check the list against the spec's actual mutable fields — a field missing from
the list can never be changed, and a field present but incompatible with another produces an
`Internal` error from the API server rather than an `InvalidArgument` from us.

**Say what an identifier is.** Every resource documents how `id` relates to `metadata.name`.
Where they differ — because uniqueness is a pair, as for namespaced resources — the contract
says what `id` is derived from. A primary key nobody can construct blocks implementation.

## Deviating from the OSAC service standards

`mpaulgreen/osac-service-standards` is the reference. Deviating is allowed and sometimes
right, but it is recorded, never silent: an ADR, plus a comment at the point of deviation
pointing at it. Reviewers arriving from the standard will otherwise "fix" it.

Current deviations: [ADR-0003](docs/adr/0003-the-resource-version-stays-a-string.md) on the
resource version, and single-tenancy, which leaves the standard's tenant-scoping invariant
unimplemented.

## Error semantics

Match on status codes, never on message text. Return `*connect.Error`; connect reads the code
from nothing else, so an ordinary Go error reaches the caller as `unknown` whatever its type.
Map at one place per package rather than at each call site, and preserve the existing code for
a given condition when changing how it is produced — a `NotFound` that silently becomes
`Internal` is a UI regression no test will name.

## The console/backend boundary

Anything that decides what data *means*, or what a request *may do*, belongs in the backend.
The BFF does transport only, and under
[ADR-0004](docs/adr/0004-the-bff-is-a-thin-relay.md) it should not compile against the
contract at all. A frontend selector may format, sort and compose for display; anything
encoding a policy or a meaning — "is this cluster a grid member", "what phase is this model
in" — is a field in the contract instead. Watch for derivations migrating into React: that is
strictly worse than the BFF doing it, because it is unversioned and invisible to the backend.

## Documentation

A claim about another repository, a file path or a version goes stale silently and nothing
checks it. When review sees one, verify it rather than assuming. Prefer pointing at the
environment — a script, a config file — over restating what it says.
