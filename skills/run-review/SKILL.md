---
name: run-review
description: >
  Runs a local cubic AI code review using the CLI on uncommitted changes or the current branch
  diff. Surfaces issues grouped by priority and offers to fix them. Use when the user wants a
  pre-commit or pre-PR quality check, says "review my code", or asks "anything I should fix".
allowed-tools: [Bash]
---

# Run Local Code Review

Run a local cubic AI code review via CLI to catch issues before committing or opening a PR.

## When To Activate

- User says "review my code", "check my changes", "run a review", or "anything I should fix"
- User is about to commit or open a PR and wants a quality check
- User asks to "scan for issues", "check for problems", or "review before merging"
- User wants to validate local changes against cubic's AI review

## Inputs

- **Flags** (optional): Pass-through flags for the cubic CLI (e.g., `-b main`, `-c HEAD~1`).

## Instructions

### 1. Check the CLI is installed

```bash
which cubic
```

If not found, show install options and stop:

```bash
curl -fsSL https://cubic.dev/install | bash
```

After installing, the user needs to authenticate with `cubic auth`.

### 2. Determine what to review

```bash
git status --porcelain
```

- If there are uncommitted changes -> `cubic review -j` (reviews working directory)
- If clean working tree -> `cubic review -b -j` (reviews branch vs base)
- If user provided flags -> `cubic review -j <flags>`

### 3. Wait for review completion

After invoking `cubic review`, do not assume the result is final immediately.

- If output indicates queued/running status (or no final `issues` array yet), poll until complete.
- **Local review window**: sleep 15 seconds between retries, up to 20 retries (5 minutes total).
- **GitHub/branch review window** (`-b` or PR-linked context): sleep 30 seconds between retries, up to 30 retries (15 minutes total).
- If still incomplete after the retry window, report timeout and include the last known status.

### 4. Parse results

The JSON output contains an `issues` array. Each issue has:

- `priority`: P0 (critical), P1 (high), P2 (medium), P3 (low)
- `file`: File path
- `line`: Line number
- `title`: Issue title
- `description`: Detailed explanation

### 5. Present issues

If no issues found, tell the user the code looks good.

If issues found, present them grouped by priority (P0 first). Highlight P0 and P1 as requiring immediate attention.

### 6. Offer to fix

List each issue by number so the user can pick which to fix. For each selected issue:

1. Read the file and surrounding context to understand the root cause
2. Validate the issue is real — if it's a false positive, explain why and skip it
3. Fix it in the simplest, cleanest way possible without refactoring unrelated code

## Output Format

```
## cubic Local Review

Found 4 issues:

### P0 — Critical (1)
1. **SQL injection in query builder** — `src/auth.ts:45`
   Unsanitized user input passed directly to SQL query.

### P1 — High (1)
2. **Missing null check** — `src/api.ts:88`
   `user.email` accessed without checking if user exists.

### P2 — Medium (1)
3. **Unhandled promise rejection** — `src/worker.ts:23`
   Async function missing try/catch around external API call.

### P3 — Low (1)
4. **Unused import** — `src/utils.ts:1`
   `lodash` imported but never used.

Which issues should I fix? (e.g., "1, 2" or "all P0 and P1")
```
