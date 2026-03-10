---
name: cubic-loop
description: >
  Iteratively improves code by running cubic AI reviews, fixing issues, and re-reviewing until
  clean or a maximum number of iterations is reached. Use when the user wants to polish their
  changes, says "loop until clean", "keep reviewing", or wants to fully optimize code quality
  before merging.
allowed-tools: [Bash]
---

# Cubic Loop

Iteratively review and fix code until cubic finds no more issues: review -> fix -> re-review -> repeat.

## When To Activate

- User says "loop until clean", "keep reviewing until done", or "cubic loop"
- User wants to fully optimize a PR or branch before merging
- User asks to "fix everything cubic finds" or "make cubic happy"

## Inputs

- **Mode** (optional): `local` (default) for CLI review, or `pr` for PR-based review.
- **Max iterations** (optional): Defaults to 5. Safety cap to prevent runaway loops.

## Instructions

### 1. Determine review mode

Check whether to use local CLI or PR-based review:

- If user said "pr" or there's an open PR for the current branch -> PR mode
- Otherwise -> local CLI mode

For **local mode**, verify the CLI is installed:

```bash
which cubic
```

If not found, show install instructions and stop:

```bash
curl -fsSL https://cubic.dev/install | bash
```

For **PR mode**, verify GitHub CLI access:

```bash
gh auth status
```

If `gh` is missing or unauthenticated, stop and tell the user they need GitHub CLI access for PR mode.

Then identify the PR:

```bash
gh pr view --json number,headRefName -q '{number: .number, branch: .headRefName}'
```

### 2. Loop (max 5 iterations)

Repeat the following cycle.

#### A. Run review

**Local mode:**

```bash
git status --porcelain
# If uncommitted changes: cubic review -j
# If clean working tree: cubic review -b -j
```

If local review output is queued/running (or no final `issues` array is available yet), poll until complete:

- Sleep 15 seconds between retries
- Retry up to 20 times (5 minutes total)
- If still pending after 5 minutes, stop the loop and report timeout

**PR mode:**

```bash
git push
```

Then wait for GitHub/PR review results to settle before fetching issues:

- Poll every 30 seconds
- Retry up to 30 times (15 minutes total)
- Only proceed once PR review output is final
- If still pending after 15 minutes, stop the loop and report timeout

After completion, use `gh api graphql` against `repository.pullRequest.reviewThreads`.

- Paginate with `reviewThreads(first: 100, after: $after)` until `pageInfo.hasNextPage` is false
- Request thread fields: `id`, `isResolved`, `isOutdated`, `path`, `line`, `originalLine`, `startLine`, `originalStartLine`, `diffSide`, `startDiffSide`, `resolvedBy { login avatarUrl }`
- Request comment fields: `comments(last: 100) { nodes { id databaseId path line originalLine startLine originalStartLine author { login } body url createdAt } }`

Prefer unresolved, non-outdated review threads. If the author identity is available, focus on comments authored by cubic's bot/app; otherwise, use the PR's review comments and note that the source could not be narrowed to cubic with certainty.

#### B. Check exit conditions

Stop the loop if ANY of these are true:

- Zero issues found -> **success, code is clean**
- Only P3 (low) issues remain and no P0/P1/P2 -> **success, good enough**
- Max iterations reached -> **stop, report remaining issues**

#### C. Fix issues

For each issue, prioritized P0 first then P1, P2:

1. Read the file and surrounding context
2. Validate the issue is real -> skip false positives
3. Fix in the simplest way possible without refactoring unrelated code
4. Track what was fixed for the summary

When there are multiple independent issues, use sub-agents where available to verify and fix them in parallel.

- Give each sub-agent one issue or one disjoint file set
- Ask each sub-agent to independently validate whether the issue is real before fixing
- Keep fixes isolated so they do not overwrite each other
- Review and integrate each sub-agent result before moving to the next review iteration

Skip P3 issues unless the user explicitly requested "fix everything".

#### D. Commit and continue

```bash
git add -A
git commit -m "fix: address cubic review feedback (iteration N)"
```

Go back to step A.

### 3. Report

After exiting the loop, present a summary.

## Output Format

**Clean exit:**

```
## Cubic Loop Complete

Iterations:   2
Issues fixed: 5
Remaining:    0

Changes:
- Iteration 1: Fixed SQL injection (P0), added null checks (P1 x2)
- Iteration 2: Fixed error handling (P2), added input validation (P2)

All commits pushed. Ready to merge.
```

**Max iterations reached:**

```
## Cubic Loop — Stopped after 5 iterations

Iterations:   5
Issues fixed: 11
Remaining:    2

Remaining issues:
- src/legacy.ts:234 — P2: "Consider extracting this into a utility function"
- src/config.ts:12 — P3: "Magic number could be a named constant"

These may be intentional trade-offs. Review manually or run again.
```
