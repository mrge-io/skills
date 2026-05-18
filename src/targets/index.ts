import { claude } from "./claude.js"
import { opencode } from "./opencode.js"
import { codex } from "./codex.js"
import { cursor } from "./cursor.js"
import { droid } from "./droid.js"
import { pi } from "./pi.js"
import { gemini } from "./gemini.js"
import { universal } from "./universal.js"

import type { InstallMethod } from "../utils.js"
export interface TargetResult {
  skills: number
  commands: number
  prompts: number
  mcpServers: number
}

export interface Target {
  install(pluginRoot: string, outputRoot: string, method?: InstallMethod): Promise<TargetResult>
  uninstall(outputRoot: string): Promise<void>
  defaultRoot(): string
}

export const targets: Record<string, Target> = {
  claude,
  opencode,
  codex,
  cursor,
  droid,
  pi,
  gemini,
  universal,
}

export const TARGET_NAMES = Object.keys(targets)
