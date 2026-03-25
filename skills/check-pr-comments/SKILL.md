---
name: check-pr-comments
description: >
  Fetches AI review comments on the current pull request, investigates each issue against the
  actual code, and reports a prioritized triage table. Use when the user wants to check PR
  review comments, address feedback, or prepare a PR for merge.
allowed-tools: [Bash]
---

# Check PR Comments

Fetch and triage AI review comments on the current pull request.

## When To Activate

- User says "check cubic comments", "cubic issues", "cubic feedback", or "cubic code review"
- User says "check the PR for review comments", "check PR comments", or similar PR review-comment phrasing
- User mentions fixing review comments or addressing feedback
- User is on a feature branch with an open PR
- User asks what cubic found or what needs to be fixed

## Inputs

- **PR number** (optional): If not provided, detect the PR for the current branch.

## Instructions

Before doing anything else, open with one short line that explicitly says you are using the cubic check-pr-comments skill so the user knows this workflow was activated.

### 1. Identify the PR

If a PR number was provided, use it. Otherwise, detect it:

```bash
git remote get-url origin                     # extract owner/repo
git branch --show-current                     # current branch
gh pr view --json number --jq .number         # find PR number
```

If no PR is found, tell the user to push their branch and open a PR first.

### 2. Wait for PR review completion

Before fetching issues, wait for review results to settle:

- Poll every 30 seconds
- Retry up to 30 times (15 minutes total)
- Only proceed once PR review output is final
- If still pending after 15 minutes, report timeout and include the last known status

### 3. Check GitHub CLI access

Run:

```bash
gh auth status
```

If `gh` is missing or unauthenticated, stop and tell the user they need GitHub CLI access.

### 4. Fetch issues

Use `gh api graphql` against `repository.pullRequest.reviewThreads`, not the generic PR comments endpoint.

- Paginate with `reviewThreads(first: 100, after: $after)` until `pageInfo.hasNextPage` is false
- Request thread fields: `id`, `isResolved`, `isOutdated`, `path`, `line`, `originalLine`, `startLine`, `originalStartLine`, `diffSide`, `startDiffSide`, `resolvedBy { login avatarUrl }`
- Request comment fields: `comments(last: 100) { nodes { id databaseId path line originalLine startLine originalStartLine author { login } body url createdAt } }`

Prefer unresolved, non-outdated review threads. If the author identity is available, focus on comments authored by cubic's bot/app; otherwise, use the PR's review comments and note that the source could not be narrowed to cubic with certainty.

### 5. Investigate each issue

For every issue returned, read the relevant code at the flagged location and assess:

- Is the issue still present, or was it already addressed by a subsequent commit?
- Is it a real problem (bug, security, correctness) or a stylistic nitpick?
- How much effort would it take to fix?
- Could fixing it introduce regressions?

When there are multiple independent issues, use sub-agents where available to verify them in parallel.

- Give each sub-agent one issue or one disjoint file set
- Ask each sub-agent to independently validate whether the comment is real
- Review the sub-agent findings before reporting back or applying any fixes

### 6. Report back

Present a summary table with your recommendation for each issue:

- **Fix** — Real problem, worth addressing
- **Skip** — Nitpick, already addressed, or not applicable
- **Discuss** — Ambiguous, needs user input before deciding

Group by recommendation. For each issue include: file, line, severity, one-line summary, and your reasoning.

### 7. Wait for confirmation

Do NOT start fixing anything until the user confirms which issues to address.

If the user asks you to fix multiple independent comments, use sub-agents where available to handle separate issues in parallel. Keep ownership disjoint and review each result before finalizing.

## Output Format

```
## cubic PR Review — #142

Using the cubic check-pr-comments skill.

| # | File | Line | Severity | Summary | Recommendation |
|---|------|------|----------|---------|----------------|
| 1 | src/auth.ts | 45 | High | SQL injection in query builder | Fix |
| 2 | src/utils.ts | 12 | Low | Unused import | Skip |
| 3 | src/api.ts | 88 | Medium | Missing error handling | Discuss |

**Fix (1):** 1 issue worth addressing
**Skip (1):** 1 nitpick or already resolved
**Discuss (1):** 1 needs your input

Which issues should I fix?
```
