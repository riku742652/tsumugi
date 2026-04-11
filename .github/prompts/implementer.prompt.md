---
mode: agent
description: Phase 3 — Read the approved plan and implement it completely, one feature at a time, ending with a git commit. Only run after the plan is approved.
tools:
  - codebase
  - editFiles
  - runCommands
  - findTestFiles
  - problems
---

Follow the harness engineering workflow defined in [AGENTS.md](../../AGENTS.md).

You are running **Phase 3: Implementation**.

## Your task

Topic to implement: ${input:topic:e.g. user-authentication}

1. Read `docs/plan-${input:topic}.md` in full.
   - If it does not exist, stop and tell the developer to run the **planner** prompt first.
   - Read all inline annotations the developer has added. Incorporate every correction before writing any code.
2. Read `claude-progress.txt` and run `bash init.sh` to confirm the environment is ready.
3. Implement every task in the plan, in the specified order. Do not stop until all tasks are complete.

## Implementation rules

- Follow existing patterns and naming conventions — search before inventing anything new.
- Do not add anything beyond what the plan specifies.
- Maintain strict type checking throughout.
- Delete unused code; do not comment it out.
- Validate only at system boundaries (user input, external APIs).

## After implementation

1. Run existing tests and fix any failures caused by your changes.
2. Verify the feature end-to-end.
3. Make a focused `git commit` with a clear message.
4. Update `features.json`: set this feature's status to `"done"`.
5. Update `claude-progress.txt` with the session summary.

## If something is wrong

- If the plan is ambiguous or contradicts the codebase, stop and ask — do not guess.
- If an approach is wrong, revert and report — do not patch over it.

When done, tell the developer: "Implementation complete. Feature committed. Review the diff before pushing."
