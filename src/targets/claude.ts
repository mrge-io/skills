import path from "path"
import os from "os"
import { promises as fs } from "fs"
import { execFile } from "child_process"
import { isDeepStrictEqual, promisify } from "util"
import type { Target, TargetResult } from "./index.js"
import type { InstallMethod } from "../utils.js"
import {
  pathExists,
  installSkills,
  uninstallSkills,
  installFile,
  mergeJsonConfig,
  readJson,
  removeMcpFromJsonConfig,
} from "../utils.js"

const COMMANDS = ["comments.md", "wiki.md", "scan.md", "learnings.md", "run-review.md"]

const CUBIC_MCP_URL = "https://www.cubic.dev/api/mcp"
const CUBIC_MCP_SERVER = { type: "http", url: CUBIC_MCP_URL }
const MCP_ADD_ARGS = ["mcp", "add", "--scope", "user", "--transport", "http", "cubic", CUBIC_MCP_URL]
const MCP_REMOVE_ARGS = ["mcp", "remove", "cubic", "--scope", "user"]
const CLAUDE_MISSING_REASON =
  `MCP server not added because the claude command was not found. Run: claude ${MCP_ADD_ARGS.join(" ")}`

const execFileAsync = promisify(execFile)

export function claudeUserConfigPath(): string {
  return path.join(process.env.CLAUDE_CONFIG_DIR || os.homedir(), ".claude.json")
}

export function isClaudeDefaultRoot(outputRoot: string): boolean {
  return outputRoot === os.homedir()
}

export function isLegacyClaudeMcpEntry(entry: unknown): boolean {
  return isDeepStrictEqual(entry, CUBIC_MCP_SERVER)
}

type ClaudeRun =
  | { status: "ok" }
  | { status: "missing" }
  | { status: "failed"; output: string }

async function runClaude(args: string[]): Promise<ClaudeRun> {
  try {
    await execFileAsync("claude", args)
    return { status: "ok" }
  } catch (err) {
    const error = err as NodeJS.ErrnoException & { stdout?: string; stderr?: string }
    if (error.code === "ENOENT") return { status: "missing" }
    return { status: "failed", output: `${error.stdout ?? ""}${error.stderr ?? ""}`.trim() }
  }
}

async function addCubicToUserConfig(): Promise<boolean> {
  const run = await runClaude(MCP_ADD_ARGS)
  if (run.status === "missing") return false
  if (run.status === "failed" && !run.output.includes("already exists in user config")) {
    throw new Error(`claude mcp add failed: ${run.output}`)
  }
  return true
}

async function removeCubicFromUserConfig(): Promise<void> {
  const run = await runClaude(MCP_REMOVE_ARGS)
  if (run.status === "failed" && !run.output.includes("No MCP server named")) {
    throw new Error(`claude mcp remove failed: ${run.output}`)
  }
}

async function removeLegacyMcpJsonEntry(configPath: string): Promise<void> {
  if (!(await pathExists(configPath))) return
  const config = await readJson(configPath)
  const servers = (config.mcpServers ?? {}) as Record<string, unknown>
  if (!isLegacyClaudeMcpEntry(servers.cubic)) return
  delete servers.cubic
  if (Object.keys(servers).length === 0) delete config.mcpServers
  if (Object.keys(config).length === 0) {
    await fs.unlink(configPath)
  } else {
    await fs.writeFile(configPath, JSON.stringify(config, null, 2) + "\n")
  }
}

type McpRegistration = Pick<TargetResult, "mcpServers" | "reason">

async function registerInUserConfig(outputRoot: string): Promise<McpRegistration> {
  if (!(await addCubicToUserConfig())) {
    return { mcpServers: 0, reason: CLAUDE_MISSING_REASON }
  }
  await removeLegacyMcpJsonEntry(path.join(outputRoot, ".mcp.json"))
  return { mcpServers: 1 }
}

async function writeMcpJson(outputRoot: string): Promise<McpRegistration> {
  await mergeJsonConfig(path.join(outputRoot, ".mcp.json"), { cubic: CUBIC_MCP_SERVER })
  return { mcpServers: 1 }
}

export const claude: Target = {
  async install(pluginRoot: string, outputRoot: string, method: InstallMethod = "paste"): Promise<TargetResult> {
    const registration = isClaudeDefaultRoot(outputRoot)
      ? await registerInUserConfig(outputRoot)
      : await writeMcpJson(outputRoot)

    const claudeDir = path.join(outputRoot, ".claude")
    const skillCount = await installSkills(pluginRoot, path.join(claudeDir, "skills"), method)

    const cmdSource = path.join(pluginRoot, "commands")
    let cmdCount = 0
    if (await pathExists(cmdSource)) {
      const cmdTarget = path.join(claudeDir, "commands")
      await fs.mkdir(cmdTarget, { recursive: true })
      for (const file of await fs.readdir(cmdSource)) {
        if (!file.endsWith(".md")) continue
        await installFile(path.join(cmdSource, file), path.join(cmdTarget, file), method)
        cmdCount++
      }
    }

    return { skills: skillCount, commands: cmdCount, prompts: 0, ...registration }
  },

  async uninstall(outputRoot: string): Promise<void> {
    const claudeDir = path.join(outputRoot, ".claude")
    await uninstallSkills(path.join(claudeDir, "skills"))
    for (const cmd of COMMANDS) {
      const p = path.join(claudeDir, "commands", cmd)
      if (await pathExists(p)) await fs.unlink(p)
    }
    if (isClaudeDefaultRoot(outputRoot)) await removeCubicFromUserConfig()
    await removeMcpFromJsonConfig(path.join(outputRoot, ".mcp.json"), "cubic")
    console.log("  claude: removed")
  },

  defaultRoot(): string {
    return os.homedir()
  },
}
