---
name: run-review
description: Run cubic AI code review on local changes
argument-hint: [-b [branch] | -c <commit> | -p <prompt>]
allowed-tools: [Bash]
---

# cubic Run Review

Run a headless cubic AI code review on local changes using the CLI.

## Arguments

User-provided flags: $ARGUMENTS

## Instructions

1. **Check CLI is installed**: Run `which cubic`. If not found, stop and show the user this install command:

   ```bash
   curl -fsSL https://cubic.dev/install | bash
   ```

   After installing, the user needs to authenticate by running `cubic auth` and following the browser login flow. Once done, they can re-run this command.

2. **Run the review** (always include `-j` for JSON output):
   - If the user provided flags (e.g. `-b main`, `-c HEAD~1`, `-p "..."`), pass them through: `cubic review -j <user flags>`
   - If no flags provided, check for uncommitted changes: `git diff --stat`
     - If there are uncommitted changes → `cubic review -j` (reviews working directory)
     - If there are no uncommitted changes → `cubic review -b -j` (falls back to branch vs base review)

3. **Parse the JSON output**: The output contains an `issues` array. Each issue has:
   - `priority`: P0 (critical), P1 (high), P2 (medium), P3 (low)
   - `file`: File path
   - `line`: Line number
   - `title`: Issue title
   - `description`: Detailed explanation

4. **Present results**: Group issues by priority. For each issue show the file, line, title, and description. Highlight P0/P1 issues as requiring immediate attention.

5. **If no issues found**: Congratulate the user — the code looks good.

6. **Offer to fix**: List each issue by number (e.g. "1. P0 — SQL injection in auth.ts:45") and ask which ones the user wants you to fix. Then for each selected issue:
   - Read the file and surrounding context to deeply understand the root cause
   - Validate the issue is real — if it's a false positive, explain why and skip it
   - Fix it in the simplest, cleanest way possible. Do not overcomplicate. Do not refactor unrelated code
