---
name: codebase-context
description: >
  Queries cubic's AI-generated wiki to provide architectural context about the codebase.
  Answers questions about how systems work, how components connect, and codebase design.
  Use when the user asks about architecture, system design, onboarding, or "how does X work".
allowed-tools: [Bash, cubic:list_wiki_pages, cubic:get_wiki_page]
---

# Codebase Context

Query cubic's AI-generated wiki to answer questions about codebase architecture and design.

## When To Activate

- User asks how a system or feature works
- User is onboarding to a new codebase
- User needs to understand how components connect
- User asks about architecture, data flow, or system design
- User is making changes that span multiple modules and needs context

## Inputs

- **Question** (required): What the user wants to know about the codebase.

## Instructions

### 1. Detect the repository

```bash
git remote get-url origin
```

Extract the owner and repo name from the remote URL.

### 2. Find relevant pages

Call `list_wiki_pages` with the owner and repo. Match page titles and descriptions to the user's question.

### 3. Fetch content

Call `get_wiki_page` for the most relevant pages (1–3 pages max).

### 4. Synthesize an answer

Combine wiki content into a focused answer for the user's specific question. Connect wiki knowledge to the specific files or modules the user is working with.

## Output Format

Summarize the relevant wiki content — don't dump entire pages. Reference specific wiki pages so the user can explore further.

```
Based on the cubic wiki for this repo:

**Authentication Flow**
The auth system uses JWT tokens with refresh rotation. Login requests hit
`src/auth/login.ts` which validates credentials against the user store,
then issues a token pair via `src/auth/tokens.ts`.

-> Wiki: "Authentication Architecture" · "Token Lifecycle"

**Related files:** src/auth/login.ts, src/auth/tokens.ts, src/middleware/auth.ts
```

If no wiki exists for this repo, suggest the user set one up in the cubic dashboard.
