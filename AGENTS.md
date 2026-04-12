# Harness Engineering Instructions

This is the single source of truth for AI-assisted development in this repository.
Claude Code, OpenAI Codex, and other agents read this file directly.
GitHub Copilot is directed here via `.github/copilot-instructions.md`.

---

## Core Principle

**Never write code until a written plan has been reviewed and approved.**
Research → Plan (with annotation) → Implement. In that order, always.

---

## Session Startup Protocol

At the start of every session, perform these steps before touching any code:

1. Read `claude-progress.txt` to understand prior work and current state
2. Review `features.json` to identify what is done, in-progress, and pending
3. Run `bash init.sh` to restore the development environment
4. Run existing tests to surface any undocumented regressions
5. Confirm which single feature to work on next

---

## Three-Phase Workflow

### Phase 1: Research

Before proposing any plan, deeply explore all relevant parts of the codebase.

- Document findings in `docs/research-<topic>.md`
- Use precise, specific language: "list every file that touches X", not "look at X"
- Identify existing patterns, types, and conventions to follow
- Do not skip files that might be relevant — read in detail

Output: a research document the developer can verify before planning begins.

### Phase 2: Plan

Create a detailed implementation plan in `docs/plan-<topic>.md`.

Include for each task:
- File path(s) and function/class names to change
- Code snippets showing the before/after or new additions
- Trade-offs and alternatives considered
- Dependencies between tasks and their order

**Wait for explicit approval before proceeding to Phase 3.**

#### Annotation Cycle

The developer will add inline comments to the plan document. Iterate until the plan is approved:
- Incorporate corrections without rewriting unaffected sections
- Ask clarifying questions as inline comments, not verbally
- Typical cycles: 1–6 rounds

### Phase 3: Implementation

Once the plan is approved:

- Work on **one feature at a time** — never attempt to implement everything at once
- Do not stop mid-feature; complete each unit of work fully
- Maintain strict type checking throughout
- Verify features end-to-end (browser/CLI/tests) before marking done
- End every feature with a focused `git commit`
- **Always work on a `feature/<topic>` or `fix/<topic>` branch — never commit directly to `main`**
- Merge to `main` only via a pull request

---

## Progress Management

### `claude-progress.txt`

Update at the end of every session:

```
Session: <date>
Completed: <what was finished>
In Progress: <what is partially done>
Blocked: <any blockers>
Next: <the very next concrete step>
Environment: <any env state to restore>
```

### `features.json`

Maintain feature status as: `"pending"`, `"in_progress"`, or `"done"`.
Work on only one `"in_progress"` feature at a time.

---

## Clean State Transitions

At session end:
1. Commit all completed work with a clear message
2. If work is incomplete, stash or commit a WIP with `[WIP]` prefix
3. Update `claude-progress.txt`
4. Update `features.json` statuses
5. Run tests one final time to confirm nothing is broken

If a direction is wrong: **revert and re-scope**, do not patch over bad approaches.

---

## Code Quality Rules

- Follow existing patterns and naming conventions — grep before inventing
- Do not add features, refactors, or "improvements" beyond what the plan specifies
- Do not add error handling for scenarios that cannot occur
- Delete unused code; do not rename it or comment it out
- Validate only at system boundaries (user input, external APIs)

---

## Testing

- Write tests that cover the feature as a user would experience it
- Prefer integration tests over unit tests for end-to-end behavior
- Do not mock internal modules unless external I/O forces it
- Run tests before and after implementation

---

## Reference Files

| File | Purpose |
|------|---------|
| `init.sh` | Restore dev environment at session start |
| `claude-progress.txt` | Cross-session continuity log |
| `features.json` | Feature status tracker |
| `docs/research-*.md` | Research artifacts (one per topic) |
| `docs/plan-*.md` | Implementation plans (one per feature) |
