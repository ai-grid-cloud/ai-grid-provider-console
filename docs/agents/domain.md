# Domain Docs

This repository has one domain context. Before exploring or changing domain behavior, read:

- [GLOSSARY.md](../../GLOSSARY.md) for canonical terms.
- The relevant decisions in [docs/adr/](../adr/) for the area being changed.

Use the glossary's vocabulary in issue titles, proposals, tests and explanations. Organization
is the customer resource; `Tenants` is the backend's legacy API name. Preserve existing API
identifiers when referring to that contract.

Read each ADR's status and delivery notes: accepted direction can differ from today's code,
and proposed decisions are not implementation requirements. If a change conflicts with an
ADR, surface the conflict explicitly and explain why it should be reconsidered.

When a term or decision is resolved, update the root glossary or ADR directory. Keep the
glossary focused on definitions and the ADRs on decisions and their consequences.
