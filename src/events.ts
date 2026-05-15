import { randomUUID } from "crypto"

import type { InstallMethod } from "./utils.js"
// ── Event types ──────────────────────────────────────────────

export interface InstallStartedEvent {
  type: "install_started"
  mode: "full" | "skills-only"
  method: InstallMethod
  target: string
  pluginVersion: string
}

export interface TargetStartedEvent {
  type: "target_started"
  agent: string
}

export interface TargetSkippedEvent {
  type: "target_skipped"
  agent: string
  reason: "not_detected"
}

export interface TargetResultEvent {
  type: "target_result"
  agent: string
  method: InstallMethod
  skills: number
  commands: number
  prompts: number
  mcpServers: number
  status: "ok" | "failed"
  reason: string | null
}

export interface InstallSummaryEvent {
  type: "install_summary"
  targetsTotal: number
  targetsSucceeded: number
  targetsFailed: number
  skillsTotal: number
  commandsTotal: number
  promptsTotal: number
  mcpServersTotal: number
  pluginVersion: string
}

export interface InstallCompletedEvent {
  type: "install_completed"
  ok: true
}

export interface InstallFailedEvent {
  type: "install_failed"
  code: string
  message: string
  retryable: boolean
}

export type InstallEvent =
  | InstallStartedEvent
  | TargetStartedEvent
  | TargetSkippedEvent
  | TargetResultEvent
  | InstallSummaryEvent
  | InstallCompletedEvent
  | InstallFailedEvent

// ── Emitter ──────────────────────────────────────────────────

export type Emitter = (event: InstallEvent) => void

export function createEmitter(jsonMode: boolean): Emitter {
  if (!jsonMode) return () => {}

  const runId = randomUUID().replace(/-/g, "").slice(0, 12)

  return (event: InstallEvent) => {
    const { type, ...rest } = event
    const full = {
      type,
      version: 1 as const,
      ts: new Date().toISOString(),
      runId,
      ...rest,
    }
    process.stdout.write(JSON.stringify(full) + "\n")
  }
}
