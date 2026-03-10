---
name: comments
description: Show cubic's review comments on a pull request
argument-hint: [pr-number]
allowed-tools: [Bash]
---

# cubic PR Comments

Show the review comments on a pull request using GitHub review threads.

## Arguments

If a PR number was provided: $ARGUMENTS
If not, detect the current PR automatically.

## Instructions

1. **Check GitHub CLI access**: Run `gh auth status`. If `gh` is missing or unauthenticated, stop and tell the user they need GitHub CLI access.

2. **Detect the repository**: Run `git remote get-url origin` to extract the owner and repo name from the remote URL. Parse `owner/repo` from it.

3. **Detect the PR number**: If the user provided a PR number in the arguments, use it. Otherwise:
   - Run `git branch --show-current` to get the current branch
   - Run `gh pr view --json number --jq .number` to find the open PR for this branch
   - If no PR is found, tell the user no open PR exists for this branch

4. **Wait for PR review completion**: Before fetching comments, wait for review output to settle:
   - Poll every 30 seconds
   - Retry up to 30 times (15 minutes total)
   - Only proceed once PR review output is final
   - If still pending after 15 minutes, report timeout and include the last known status

5. **Get comments from GitHub**: Use `gh api graphql` against `repository.pullRequest.reviewThreads`, not the generic PR comments endpoint.

   - Paginate with `reviewThreads(first: 100, after: $after)` until `pageInfo.hasNextPage` is false
   - Thread fields: `id`, `isResolved`, `isOutdated`, `path`, `line`, `originalLine`, `startLine`, `originalStartLine`, `diffSide`, `startDiffSide`, `resolvedBy { login avatarUrl }`
   - Comment fields: `comments(last: 100) { nodes { id databaseId path line originalLine startLine originalStartLine author { login } body url createdAt } }`

   Prefer unresolved, non-outdated review threads. If the review author can be identified, prioritize comments authored by cubic's bot/app; otherwise, show the review comments and note that GitHub did not expose a reliable cubic-specific identity.

6. **Present results**: Display the comments grouped by file. For each comment show:
   - File and line numbers
   - Severity level
   - The full comment content
