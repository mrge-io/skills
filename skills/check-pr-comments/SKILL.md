---
name: check-pr-comments
description: >
  Fetches unresolved AI review comments on the current pull request, decides which issues are real and worth addressing, fixes the worthwhile ones, commits and pushes the changes, and resolves the reviewed threads. Use when the user asks to check all PR comments, refers to PR comments or issues, or wants PR review feedback handled end to end.
allowed-tools: [Bash]
---

# Check PR Comments

Fetch unresolved AI review comments on the current pull request and handle them end to end.

## When To Activate

- User says "check all PR comments", "check all the comments on the PR", or similar phrasing
- User says "check cubic comments", "cubic issues", "cubic feedback", or "cubic code review"
- User says "check the PR for review comments", "check PR comments", "look at the PR issues", or similar PR comment/issue phrasing
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

### 4. Fetch unresolved review threads only

Use `gh api graphql` against `repository.pullRequest.reviewThreads`, not the generic PR comments endpoint.

- Paginate with `reviewThreads(first: 100, after: $after)` until `pageInfo.hasNextPage` is false
- Request thread fields: `id`, `isResolved`, `isOutdated`, `path`, `line`, `originalLine`, `startLine`, `originalStartLine`, `diffSide`, `startDiffSide`, `resolvedBy { login avatarUrl }`
- Request comment fields: `comments(last: 100) { nodes { id databaseId path line originalLine startLine originalStartLine author { login } body url createdAt } }`

Filter aggressively before doing deeper analysis:

- Only keep threads where `isResolved` is `false`
- Skip outdated threads unless they still point to a live issue you can verify in the current diff

The goal is to keep context focused on unresolved review feedback, not historical or already-closed discussion.

### 5. Decide which issues are real and worth addressing

For every issue returned, read the relevant code at the flagged location and assess:

- Is the issue still present, or was it already addressed by a subsequent commit?
- Is it a real problem (bug, security, correctness) or a stylistic nitpick?
- How much effort would it take to fix?
- Could fixing it introduce regressions?

Make the decision yourself. Do not stop to ask the user which issues to fix.

Use this default decision rule:

- **Address now** — correctness, reliability, security, data integrity, broken tests, clear maintainability wins, or low-risk fixes that materially improve the PR
- **Do not change code** — already fixed, false positive, subjective preference, or changes with unclear benefit or high regression risk
- **Discuss at the end** — ambiguous tradeoffs, product decisions, or risky changes that need user judgment after you finish everything else you can handle safely

When there are multiple independent issues, use sub-agents where available to verify them in parallel.

- Give each sub-agent one issue or one disjoint file set
- Ask each sub-agent to independently validate whether the comment is real
- Review the sub-agent findings before applying any fixes

### 6. Fix the worthwhile issues

Apply fixes for every issue you decided is worth addressing.

Match existing codebase patterns. After editing, run the relevant validation for the touched files.

At minimum, do the checks that fit the repo:

- Focused tests for the touched area
- Lint or typecheck if applicable
- Any targeted command needed to verify the fix really addressed the review comment

If a proposed fix is not safe after investigation, leave the code unchanged for that issue and include it in the final summary under discussion or unresolved outcome as appropriate.

### 7. Commit and push when code changed

If you changed code:

- Create one clear git commit that summarizes the review-comment fixes
- Push the branch to origin

If no code changes were needed, do not create an empty commit.

### 8. Resolve the reviewed threads without replying

After investigation is complete, resolve every unresolved thread you handled.

- Do not add PR reply comments
- Do not post justification comments unless the user explicitly asks for them
- Use GitHub's review-thread resolution mechanism directly
- If you fixed code, resolve the related threads after the commit is pushed
- If a thread was a false positive or already fixed, resolve it after confirming that conclusion

### 9. Report back with the outcome

Present a concise summary grouped by outcome:

- **Fixed and resolved** — issues you changed in code, then committed, pushed, and resolved
- **Resolved without code changes** — false positives, already-fixed items, or items not worth changing
- **Needs discussion** — issues you intentionally left for the user because they require judgment beyond a safe autonomous fix
- **Left unresolved** — only use this if something was truly blocked and could not be safely handled

For each issue include: file, line, one-line summary, and the reason for the outcome.

If you created a commit, include the commit hash and branch name in the summary.

If there are any discussion items, ask the user about them at the very end after reporting everything else.

## Output Format

```
## cubic PR Review — #142

Using the cubic check-pr-comments skill.

### Fixed and resolved

| # | File | Line | Summary | Result |
|---|------|------|---------|--------|
| 1 | src/auth.ts | 45 | SQL injection in query builder | Fixed, committed, pushed, and resolved |

### Resolved without code changes

| # | File | Line | Summary | Result |
|---|------|------|---------|--------|
| 2 | src/utils.ts | 12 | Unused import | Already fixed in branch, resolved thread |
| 3 | src/api.ts | 88 | Missing error handling | Not worth changing as written, resolved thread |

### Needs discussion

| # | File | Line | Summary | Result |
|---|------|------|---------|--------|
| 4 | src/billing.ts | 64 | Retry policy for failed charges | Risky product tradeoff, left for user decision |

Commit: `abc1234` on `feature/my-branch`

I handled everything else I could safely. Should I also change the billing retry policy in `src/billing.ts:64`?
```
