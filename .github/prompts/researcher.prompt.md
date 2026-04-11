---
mode: agent
description: Phase 1 — Deeply explore the codebase for a given topic and write docs/research-<topic>.md. Run before planning.
tools:
  - codebase
  - editFiles
  - runCommands
---

Follow the harness engineering workflow defined in [AGENTS.md](../../AGENTS.md).

You are running **Phase 1: Research**.

## Your task

Topic to investigate: ${input:topic:e.g. user-authentication}

1. Read `claude-progress.txt` and `features.json` to understand current context.
2. Deeply explore every file in the codebase relevant to the topic.
   - Do not skim. Read each file in full if it might be relevant.
   - Search for all symbols, types, and patterns related to the topic.
   - Identify existing conventions, abstractions, and naming patterns.
3. Write your findings to `docs/research-${input:topic}.md` using this structure:

```
# Research: <topic>

## Relevant Files
Every file that touches this topic, with a one-line summary of its role.

## Existing Patterns
Conventions, types, and abstractions the implementation must follow.

## Entry Points
Key functions/classes where control flow enters for this area.

## Constraints & Gotchas
Anything that will constrain implementation or cause problems if ignored.

## Open Questions
Ambiguities the developer must resolve before planning can begin.
```

## Rules

- Do not propose a solution or write any implementation code.
- Do not skip files because you think they are probably irrelevant — verify first.
- If the codebase is empty or has no prior art for this topic, say so explicitly.

When done, tell the developer: "Research complete. Review `docs/research-${input:topic}.md` before starting the Plan phase."
