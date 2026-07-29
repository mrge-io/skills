---
name: handle-codebase-scan
description: >
  Inspects and fixes cubic codebase scan findings through MCP. Use when the user asks to show,
  investigate, or fix codebase scan issues; provides a cubic scan CSV; or names a scan issue UUID.
allowed-tools: [Bash, cubic:list_scans, cubic:get_scan, cubic:get_issue]
---

# Handle Codebase Scan

Retrieve full scan reports through cubic MCP, verify each finding against the current checkout, and
make only the changes the user requests.

## Instructions

### 1. Choose the input path

- For a repository request, detect `owner/repo` from `git remote get-url origin`. Support common
  HTTPS and SSH GitHub URLs and remove a trailing `.git`.
- If the repository cannot be identified, call `list_scans` to discover accessible repositories.
  Do not call it first when the current repository is known.
- For a CSV request, read the supplied local CSV and extract valid UUIDs from the `violationId`
  query parameter in its `Issue link` column. Deduplicate the UUIDs and ignore the scan ID portion
  of each URL because `get_issue` uses the stable issue UUID.

### 2. Retrieve findings

- In repository mode, call `get_scan` with `owner`, `repo`, `triageStatus: "open"`, `limit: 10`,
  and `offset: 0` by default. The response aggregates the latest completed full scan with newer
  completed diff scans; it does not accept a scan ID.
- Apply `category`, `minSeverity`, `filePath`, or a different `triageStatus` only when the user asks
  for it. For "unresolved" findings, retrieve both `open` and `in_review`. Retrieve all statuses
  only when the user explicitly asks for them.
- Do not follow `hasMore` by default. Show the first page and its total count, then fetch another
  page only when the user asks for more or explicitly requested a larger result set.
- For listing requests, present the `get_scan` summaries without fetching every full report. Fetch
  an issue with the cubic codebase scan `get_issue` tool only when the user asks to investigate or
  fix it.
- For an investigation or fix request without a user-selected issue list, process at most the five
  highest-severity findings in one batch and report how many remain.
- In CSV or issue-ID mode, call `get_issue` directly for each selected UUID. Process no more than
  five issues per batch and load one full report at a time.
- If a required cubic codebase scan MCP tool is unavailable, stop and ask the user to connect and
  authenticate the cubic MCP integration. Do not retry the same unavailable tool for every issue.

### 3. Verify and act

When the user asks to investigate or fix findings, process each selected finding:

1. Read the full MCP report and the referenced code on the current checkout.
2. Classify it as still present, already absent, false positive, or blocked.
3. If the issue is real and the user requested fixes, make the smallest root-cause fix.
4. Run focused tests or file-targeted linting for the touched area.

Do not commit, push, open a pull request, or update cubic triage state unless the user explicitly
requests that separate action.

## Output

For listing requests, show the issue UUID, severity, category, file location, and summary. For
investigation or fix requests, report each selected finding as still present, fixed, already
absent, false positive, or blocked. Include focused verification for every code change.
