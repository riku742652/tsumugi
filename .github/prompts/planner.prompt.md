---
mode: agent
description: Phase 2 — Read the research doc and write a detailed implementation plan to docs/plan-<topic>.md. Run after researcher, before implementer.
tools:
  - codebase
  - editFiles
---

Follow the harness engineering workflow defined in [AGENTS.md](../../AGENTS.md).

You are running **Phase 2: Plan**.

## Your task

Topic to plan: ${input:topic:e.g. user-authentication}

1. Read `docs/research-${input:topic}.md` in full.
   - If it does not exist, stop and tell the developer to run the **researcher** prompt first.
2. Read `features.json` to confirm the feature is listed.
3. Write a detailed implementation plan to `docs/plan-${input:topic}.md`:

```
# Plan: <topic>

## Overview
One paragraph describing what will be built and why.

## Tasks

### Task 1: <name>
- **File(s):** exact/path/to/file.ts
- **Change:** What to add, remove, or modify — include before/after snippets
- **Why:** The reason this change is needed

### Task 2: ...

## Task Order
Which tasks must happen before others, and why.

## Trade-offs & Alternatives
What other approaches were considered and why they were rejected.

## Out of Scope
Anything explicitly excluded from this plan.
```

## Rules

- Reference exact file paths and function/class names from the research document.
- Include concrete code snippets, not vague descriptions.
- Do not include tasks beyond what is needed for this feature.
- Do not begin implementation.

When done, tell the developer: "Plan complete. Review and annotate `docs/plan-${input:topic}.md`, then approve it to begin implementation."
