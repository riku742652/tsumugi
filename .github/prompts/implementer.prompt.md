---
mode: agent
description: Phase 3 — Read the approved plan, implement it, open a PR, handle Gemini/Copilot review comments, and merge when all reviewers are satisfied.
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
3. Update `features.json`: set this feature's status to `"done"`.
4. Update `claude-progress.txt` with the session summary.

## Branch and PR

5. Create a feature branch and push:
   ```
   git checkout -b feature/${input:topic}
   git add -A
   git commit -m "${input:topic}: <one-line summary>"
   git push -u origin feature/${input:topic}
   ```
6. Create a pull request targeting `main`:
   ```
   gh pr create --base main --title "${input:topic}: <one-line summary>" --body "$(cat docs/plan-${input:topic}.md)"
   ```
   Note the PR number from the output.

## Review cycle

7. Wait 90 seconds for Gemini Code Assist and GitHub Copilot to post their reviews:
   ```
   sleep 90
   ```
8. Fetch all review comments on the PR:
   ```
   gh pr view <number> --json reviews,comments
   gh api repos/{owner}/{repo}/pulls/<number>/comments
   ```
9. For each comment that raises a concern or requests a change:
   a. Address it in the code (edit the relevant file, then `git add` and `git commit`).
   b. Push the fix: `git push`.
   c. Reply to the comment with a mention and explanation:
      ```
      gh api repos/{owner}/{repo}/pulls/<number>/comments/<comment_id>/replies \
        -f body="@<reviewer_login> <explanation of what was changed and why>"
      ```
10. Repeat step 9 until all reviewer threads are addressed.

## Merge condition

11. Fetch the latest state of all reviews:
    ```
    gh pr view <number> --json reviews
    ```
    - If every reviewer's latest comment is an approval or positive/neutral with no remaining concerns → merge:
      ```
      gh pr merge <number> --squash --delete-branch
      ```
    - If any reviewer still has an unresolved concern → return to step 9.

## If something is wrong

- If the plan is ambiguous or contradicts the codebase, stop and ask — do not guess.
- If an approach is wrong, revert and report — do not patch over it.

When done, tell the developer: "Merged. All reviewer concerns were resolved."
