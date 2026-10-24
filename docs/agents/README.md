# Agent skill configuration

These files configure coding-agent workflows. They are **not** general documentation: each one
answers a question a skill asks ("where do issues live?", "what are the triage labels?", "where
is the domain model?"), in the form that skill expects. A person reading them learns the
repository's conventions, but they are written for the tool.

| File | Read by | Says |
|---|---|---|
| [issue-tracker.md](issue-tracker.md) | `/triage`, `/wayfinder`, anything that files or reads issues | Issues are GitHub issues, driven through `gh` |
| [triage-labels.md](triage-labels.md) | `/triage` | The five canonical triage roles |
| [domain.md](domain.md) | `/domain-modeling`, `/grill-with-docs` | Single-context: one `GLOSSARY.md`, one `docs/adr/` |

Changing a file here changes agent behaviour, so treat it as configuration and not prose: if a
skill stops doing what you expect, this directory is the first place to look.

## What is not configuration

`GLOSSARY.md` and `docs/adr/` are ordinary engineering documents, for people first. Agents read
them too, and `domain.md` tells them how, but they are not written for agents and should not be
edited as though they were. An ADR exists so that a reviewer finds the reasoning before
objecting to a decision; the glossary exists so that a person stops writing one word when the
project means another.
