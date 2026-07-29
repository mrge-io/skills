---
name: scan
description: Show cubic codebase scan results and security issues
argument-hint: [issue-id]
allowed-tools: [Bash, cubic:list_scans, cubic:get_scan, cubic:get_issue]
---

# cubic Codebase Scan

Show codebase scan results from cubic, including security vulnerabilities and code quality issues.

## Arguments

If an issue ID was provided: $ARGUMENTS

## Instructions

1. **Detect the repository**: Run `git remote get-url origin` to extract the owner and repo name.

2. **If an issue ID was provided**: Call `get_issue` with the issue ID to show its full analysis report, code context, and remediation guidance.

3. **If no issue ID was provided**: Call `get_scan` with the owner and repo, plus `triageStatus: "open"`, `limit: 10`, and `offset: 0`. Apply other filters only when requested. Show the first page and total count; follow `hasMore` only when the user asks for more. Use `list_scans` only if the repository cannot be identified.

4. **Show issues**: When displaying scan results, group issues by category (Security, Data Integrity, Business Logic, Stability). For each issue show severity, file location, and summary.

5. **Dive deeper**: If the user asks about a specific issue, call `get_issue` with the issue's ID to show the full analysis report, code context, and remediation guidance.
