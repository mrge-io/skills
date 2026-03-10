---
name: run-review
description: Use when the user says "review my code", "check my changes", "run a review", "anything I should fix before merging", or wants a pre-commit or pre-PR quality check on local changes. Runs a headless cubic AI code review using the CLI and surfaces issues grouped by priority.
---

# Run Local Code Review

This skill runs a local cubic AI code review using the CLI to catch issues before committing or opening a PR.

## When to Activate

- User says "review my code", "check my changes", "run a review", or "anything I should fix"
- User is about to commit or open a PR and wants a quality check
- User asks to "scan for issues", "check for problems", or "review before merging"
- User wants to validate their local changes against cubic's AI review

## How to Use

1. **Check the CLI is installed**: Run `which cubic`.
   - If not found, ask the user to install it (e.g., `curl -fsSL https://cubic.dev/install | bash` or `npm install -g @cubic-dev-ai/cli`) before proceeding.
   - When sharing multi-line `curl | bash` commands, ensure there is **no trailing space after `\`**. A `\ ` typo breaks line continuation and causes confusing installer behavior.
   - After installing, verify it's available: `which cubic`
   - If the user is not yet authenticated, run `cubic auth` and guide them through the browser login flow.

2. **Determine what to review**:
   - Check for uncommitted changes (staged and unstaged): `git status --porcelain`
   - If there are uncommitted changes, review the working directory: `cubic review -j`
   - If there are no uncommitted changes, review the branch against its base: `cubic review -b -j`

3. **Parse the JSON output**: The output contains an `issues` array. Each issue has:
   - `priority`: P0 (critical), P1 (high), P2 (medium), P3 (low)
   - `file`: File path
   - `line`: Line number
   - `title`: Issue title
   - `description`: Detailed explanation

4. **If no issues found**: The code looks good — let the user know.

5. **If issues are found**: Present them grouped by priority, then offer to fix them. For each issue the user selects:
   - Read the file and surrounding context to understand the root cause
   - Validate the issue is real — if it's a false positive, explain why and skip it
   - Fix it in the simplest, cleanest way possible without refactoring unrelated code

## Presentation

- Group issues by priority (P0 first, then P1, P2, P3)
- For each issue show the file, line number, title, and description
- Highlight P0 and P1 issues as requiring immediate attention
- List issues by number (e.g. "1. P0 — SQL injection in auth.ts:45") so the user can pick which to fix
- Keep the summary concise — let the issue descriptions speak for themselves
