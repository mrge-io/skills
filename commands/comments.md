---
name: comments
description: Show cubic's review comments on a pull request
argument-hint: [pr-number]
allowed-tools: [Bash]
---

# cubic PR Comments

Handle unresolved cubic review comments on a pull request using GitHub review threads.

## Arguments

If a PR number was provided: $ARGUMENTS
If not, detect the current PR automatically.

## Instructions

Before doing anything else, open with one short line that explicitly says you are using the cubic PR comments command so the user knows this command was invoked.

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

5. **Fetch unresolved review threads only**: Use `gh api graphql` against `repository.pullRequest.reviewThreads`, not the generic PR comments endpoint.

   - Paginate with `reviewThreads(first: 100, after: $after)` until `pageInfo.hasNextPage` is false
   - Thread fields: `id`, `isResolved`, `isOutdated`, `path`, `line`, `originalLine`, `startLine`, `originalStartLine`, `diffSide`, `startDiffSide`, `resolvedBy { login avatarUrl }`
   - Comment fields: `comments(last: 100) { nodes { id databaseId path line originalLine startLine originalStartLine author { login } body url createdAt } }`
   - Keep only threads where `isResolved` is `false`

   The point of this command is to avoid overwhelming context with already-resolved feedback.

6. **Decide what to do with each issue**: Investigate each unresolved thread and decide whether it is a real issue worth addressing.

   - Fix clear, worthwhile issues without asking the user for confirmation first
   - Skip code changes for false positives, already-fixed items, or low-value suggestions with unclear upside
   - Save genuinely ambiguous or high-judgment items for a short question to the user at the very end

7. **Apply and verify fixes**: For issues worth addressing, make the code changes and run the relevant verification commands.

8. **Commit and push if code changed**:
   - Create one clear commit for the review-comment fixes
   - Push the branch to origin
   - If nothing changed, do not create an empty commit

9. **Resolve handled threads without replying**:
   - Resolve each reviewed unresolved thread directly
   - Do not add reply comments unless the user explicitly asked for that behavior
   - Resolve after push when code changes were made

10. **Report outcomes concisely**: Summarize which threads were fixed and resolved, which were resolved without code changes, which items need discussion, and anything that had to remain unresolved because of a real blocker.

11. **Ask only at the end if needed**:
   - If some items truly need user judgment, ask about them only after you finish all autonomous work and report the rest of the results
   - Do not stop mid-work to ask for discussion on issues you can safely defer until the end
