import { defineCommand } from "citty"
import path from "path"
import { promises as fs } from "fs"
import {
  pathExists,
  resolvePluginRoot,
  resolveInstallPluginRoot,
  installSkills,
  installAllCommands,
  isAgentDetected,
  AGENT_MARKERS,
  TARGET_LAYOUTS,
  readPluginVersion,
  readLocalPluginVersion,
  readManifest,
  writeManifest,
  type InstallMethod,
  type ManifestEntry,
  type CubicManifest,
} from "./utils.js"
import { targets, TARGET_NAMES } from "./targets/index.js"
import { createEmitter } from "./events.js"

const CUBIC_MCP_URL = "https://www.cubic.dev/api/mcp"
const CUBIC_MCP_TOML_URL_PATTERN = /(^|\n)\s*url\s*=\s*["']https:\/\/www\.cubic\.dev\/api\/mcp\/?["']\s*(?=\n|$)/

interface ResultEntry {
  agent: string
  skills: number
  commands: number
  prompts: number
  mcpServers: number
  status: "ok" | "failed"
  reason: string | null
}

function summarizeFailedTargets(failed: ResultEntry[]): string {
  if (failed.length === 1) {
    const entry = failed[0]
    return `${entry.agent} failed: ${entry.reason ?? "Unknown error"}`
  }

  const preview = failed
    .slice(0, 2)
    .map((entry) => `${entry.agent}: ${entry.reason ?? "Unknown error"}`)
    .join("; ")
  const remainder = failed.length - 2
  return remainder > 0
    ? `${failed.length} targets failed (${preview}; +${remainder} more)`
    : `${failed.length} targets failed (${preview})`
}

function formatTargetLine(name: string, r: ResultEntry): string {
  if (r.reason === "already installed") {
    return `  ${name}: already installed`
  }
  const parts = [`${r.skills} skills`]
  if (r.commands > 0) parts.push(`${r.commands} commands`)
  if (r.prompts > 0) parts.push(`${r.prompts} prompts`)
  if (r.mcpServers > 0)
    parts.push(`${r.mcpServers} MCP server${r.mcpServers !== 1 ? "s" : ""}`)
  return `  ${name}: ${parts.join(", ")}`
}

async function readJsonSectionEntry(
  configPath: string,
  section: string,
  key: string,
): Promise<Record<string, unknown> | null> {
  if (!(await pathExists(configPath))) return null
  try {
    const content = JSON.parse(
      await fs.readFile(configPath, "utf-8"),
    ) as Record<string, unknown>
    const value = content[section]
    if (typeof value !== "object" || value === null || Array.isArray(value)) {
      return null
    }
    const entry = (value as Record<string, unknown>)[key]
    if (typeof entry === "object"
      && entry !== null
      && !Array.isArray(entry)
      && Object.keys(entry).length > 0) {
      return entry as Record<string, unknown>
    }
    return null
  } catch {
    return null
  }
}

function escapeRegExp(value: string): string {
  return value.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")
}

function stripTomlLineComment(line: string): string {
  let quote: '"' | "'" | null = null
  let escaped = false

  for (let i = 0; i < line.length; i++) {
    const char = line[i]

    if (escaped) {
      escaped = false
      continue
    }

    if (quote === '"' && char === "\\") {
      escaped = true
      continue
    }

    if (quote && char === quote) {
      quote = null
      continue
    }

    if (!quote && (char === '"' || char === "'")) {
      quote = char
      continue
    }

    if (!quote && char === "#") {
      return line.slice(0, i).trimEnd()
    }
  }

  return line.trimEnd()
}

async function readTomlSectionBody(
  filePath: string,
  section: string,
): Promise<string | null> {
  if (!(await pathExists(filePath))) return null
  try {
    const content = await fs.readFile(filePath, "utf-8")
    const lines = content.split("\n")
    const headerPattern = new RegExp(
      `^\\s*\\[\\s*${escapeRegExp(section)}\\s*\\]\\s*(?:#.*)?$`,
    )
    const anySectionPattern = /^\s*\[[^\]]+\]\s*(?:#.*)?$/
    const startIndex = lines.findIndex((line) => headerPattern.test(line))
    if (startIndex === -1) return null

    const sectionLines: string[] = []
    for (let i = startIndex + 1; i < lines.length; i++) {
      if (anySectionPattern.test(lines[i])) break
      sectionLines.push(lines[i])
    }

    return sectionLines.join("\n")
  } catch {
    return null
  }
}

async function readActiveTomlSectionBody(
  filePath: string,
  section: string,
): Promise<string | null> {
  const sectionBody = await readTomlSectionBody(filePath, section)
  if (!sectionBody) return null

  const activeLines = sectionBody
    .split("\n")
    .map(stripTomlLineComment)
    .filter((line) => line.trim().length > 0)

  return activeLines.length > 0 ? activeLines.join("\n") : null
}

function readTomlInlineTableBody(
  sectionBody: string,
  key: string,
): string | null {
  const inlineTablePattern = new RegExp(
    `(^|\\n)\\s*${escapeRegExp(key)}\\s*=\\s*\\{([^\\n]*)\\}(?=\\n|$)`,
  )
  const match = sectionBody.match(inlineTablePattern)
  return match ? match[2] : null
}

function normalizeMcpEndpoint(endpoint: string): string {
  return endpoint.replace(/\/+$/, "")
}

async function jsonSectionHasMcpConfig(
  configPath: string,
  section: string,
  key: string,
  options: { requireAuth?: "oauth" } = {},
): Promise<boolean> {
  const entry = await readJsonSectionEntry(configPath, section, key)
  if (!entry) return false
  const endpoint = typeof entry.url === "string"
    ? entry.url
    : typeof entry.httpUrl === "string"
    ? entry.httpUrl
    : typeof entry.baseUrl === "string"
    ? entry.baseUrl
    : undefined
  const headers = entry.headers
  const hasHeaders = typeof headers === "object"
    && headers !== null
    && !Array.isArray(headers)
  const auth = entry.auth
  return typeof endpoint === "string"
    && normalizeMcpEndpoint(endpoint) === CUBIC_MCP_URL
    && !hasHeaders
    && (options.requireAuth
      ? auth === options.requireAuth
      : auth === undefined || auth === "oauth")
}

async function fileHasTomlMcpConfig(
  filePath: string,
  section: string,
): Promise<boolean> {
  const sectionBody = await readActiveTomlSectionBody(filePath, section)
  if (!sectionBody) return false
  const httpHeaders = readTomlInlineTableBody(sectionBody, "http_headers")
  return CUBIC_MCP_TOML_URL_PATTERN.test(sectionBody)
    && httpHeaders === null
    && !/(^|\n)\s*Authorization\s*=/.test(sectionBody)
}

function targetInstallsMcpConfig(name: string): boolean {
  return name !== "universal"
}

async function targetHasMcpConfig(
  name: string,
  outputRoot: string,
): Promise<boolean> {
  switch (name) {
    case "claude":
      return jsonSectionHasMcpConfig(
        path.join(outputRoot, ".mcp.json"),
        "mcpServers",
        "cubic",
      )
    case "cursor":
    case "droid":
      return jsonSectionHasMcpConfig(
        path.join(outputRoot, "mcp.json"),
        "mcpServers",
        "cubic",
      )
    case "gemini":
      return jsonSectionHasMcpConfig(
        path.join(outputRoot, "settings.json"),
        "mcpServers",
        "cubic",
      )
    case "opencode":
      return jsonSectionHasMcpConfig(
        path.join(outputRoot, "opencode.json"),
        "mcp",
        "cubic",
      )
    case "pi":
      return jsonSectionHasMcpConfig(
        path.join(outputRoot, ".config", "mcp", "mcp.json"),
        "mcpServers",
        "cubic",
        { requireAuth: "oauth" },
      )
    case "codex":
      return fileHasTomlMcpConfig(
        path.join(outputRoot, "config.toml"),
        "mcp_servers.cubic",
      )
    default:
      return false
  }
}

function manifestEntryKey(entry: ManifestEntry): string {
  return `${entry.type}:${entry.name}:${entry.file}:${entry.method}`
}

function manifestEntriesMatch(
  actual: ManifestEntry[],
  expected: ManifestEntry[],
): boolean {
  if (actual.length !== expected.length) return false
  const actualKeys = actual.map(manifestEntryKey).sort()
  const expectedKeys = expected.map(manifestEntryKey).sort()
  return actualKeys.every((key, index) => key === expectedKeys[index])
}

function resolveManagedEntryPath(
  name: string,
  outputRoot: string,
  entry: ManifestEntry,
): string | null {
  const layout = TARGET_LAYOUTS[name]
  if (!layout || entry.type === "mcp-config") return null
  const baseDir = entry.type === "skill"
    ? layout.skillsDir(outputRoot)
    : layout.commandDir(outputRoot)
  const relativePath = entry.type === "skill" ? entry.name : entry.file
  if (path.isAbsolute(relativePath)) return null
  const resolvedPath = path.resolve(baseDir, relativePath)
  const relativeToBase = path.relative(baseDir, resolvedPath)
  if (
    !relativeToBase
    || relativeToBase === ".."
    || relativeToBase.startsWith(`..${path.sep}`)
    || path.isAbsolute(relativeToBase)
  ) {
    return null
  }
  return resolvedPath
}

async function cleanupObsoleteManagedEntries(
  name: string,
  outputRoot: string,
  expectedEntries: ManifestEntry[],
): Promise<void> {
  const manifest = await readManifest(outputRoot, name)
  if (!manifest) return

  const expectedKeys = new Set(expectedEntries.map(manifestEntryKey))
  for (const entry of manifest.entries) {
    if (expectedKeys.has(manifestEntryKey(entry))) continue
    const managedPath = resolveManagedEntryPath(name, outputRoot, entry)
    if (!managedPath) continue
    await fs.rm(managedPath, { recursive: true, force: true })
  }
}

async function isTargetAlreadyInstalled(
  name: string,
  outputRoot: string,
  skillsOnly: boolean,
  pluginRoot: string,
  pluginVersion: string,
  method: InstallMethod,
): Promise<boolean> {
  const layout = TARGET_LAYOUTS[name]
  if (!layout) return false

  const expectedEntries = await buildManifestEntries(
    pluginRoot,
    name,
    skillsOnly,
    method,
  )
  if (expectedEntries.length === 0) return false

  const manifest = await readManifest(outputRoot, name)
  if (!manifest) return false
  if (manifest.pluginVersion !== pluginVersion) return false
  if (manifest.method !== method) return false
  if (!manifestEntriesMatch(manifest.entries, expectedEntries)) return false

  for (const entry of expectedEntries) {
    if (entry.type === "mcp-config") {
      if (!(await targetHasMcpConfig(name, outputRoot))) return false
      continue
    }

    const entryPath = entry.type === "skill"
      ? path.join(layout.skillsDir(outputRoot), entry.name, "SKILL.md")
      : path.join(layout.commandDir(outputRoot), entry.file)

    if (!(await pathExists(entryPath))) return false
  }

  return true
}

async function buildManifestEntries(
  pluginRoot: string,
  targetName: string,
  skillsOnly: boolean,
  method: InstallMethod,
): Promise<ManifestEntry[]> {
  const entries: ManifestEntry[] = []
  const layout = TARGET_LAYOUTS[targetName]

  // Skills
  const skillsSource = path.join(pluginRoot, "skills")
  if (await pathExists(skillsSource)) {
    const dirs = await fs.readdir(skillsSource, { withFileTypes: true })
    for (const d of dirs) {
      if (!d.isDirectory()) continue
      if (await pathExists(path.join(skillsSource, d.name, "SKILL.md"))) {
        entries.push({
          name: d.name,
          type: "skill",
          file: path.join("skills", d.name, "SKILL.md"),
          method,
        })
      }
    }
  }

  // Commands
  const cmdsSource = path.join(pluginRoot, "commands")
  if (await pathExists(cmdsSource)) {
    const files = await fs.readdir(cmdsSource)
    for (const file of files) {
      if (!file.endsWith(".md")) continue
      const outName = layout ? layout.commandFilename(file) : file
      // Commands with format transforms (stripped/toml) are always copied, not symlinked
      const cmdMethod = layout && layout.commandFormat !== "original" ? "paste" as InstallMethod : method
      entries.push({
        name: file.replace(/\.md$/, ""),
        type: "command",
        file: outName,
        method: cmdMethod,
      })
    }
  }

  // MCP config (only for full installs)
  if (!skillsOnly && targetInstallsMcpConfig(targetName)) {
    entries.push({
      name: "cubic",
      type: "mcp-config",
      file: "mcp-config",
      method: "paste",
    })
  }

  return entries
}

export default defineCommand({
  meta: {
    name: "install",
    description: "Install cubic plugin for AI coding tools",
  },
  args: {
    to: {
      type: "string",
      default: "all",
      description: `Target: ${TARGET_NAMES.join(", ")}, or "all"`,
    },
    output: {
      type: "string",
      alias: "o",
      description: "Output directory (overrides default per-target paths)",
    },
    "skills-only": {
      type: "boolean",
      default: false,
      description:
        "Install only skills and commands (no MCP server)",
    },
    json: {
      type: "boolean",
      default: false,
      description: "Emit newline-delimited JSON events to stdout",
    },
    method: {
      type: "string",
      default: "paste",
      description: 'Installation method: "paste" (copy files) or "symlink" (create symlinks)',
    },
    force: {
      type: "boolean",
      default: false,
      description: "Reinstall even if cubic is already installed",
    },
  },
  async run({ args }) {
    const jsonMode = Boolean(args.json)
    const emit = createEmitter(jsonMode)
    const targetName = String(args.to)
    const explicitTarget = targetName !== "all"
    const customOutput = Boolean(args.output)
    const autoDetect = !explicitTarget && !customOutput
    const initialTargets =
      targetName === "all" ? TARGET_NAMES : [targetName]
    const skillsOnly = Boolean(args["skills-only"])
    const method = String(args.method) as InstallMethod
    const force = Boolean(args.force)
    if (method !== "paste" && method !== "symlink") {
      const msg = `Unknown method: ${method}. Available: paste, symlink`
      if (jsonMode) {
        emit({
          type: "install_failed",
          code: "UNKNOWN_METHOD",
          message: msg,
          retryable: false,
        })
        process.exitCode = 1
        return
      }
      throw new Error(msg)
    }

    for (const name of initialTargets) {
      if (!targets[name]) {
        const msg = `Unknown target: ${name}. Available: ${TARGET_NAMES.join(", ")}, all`
        if (jsonMode) {
          emit({
            type: "install_failed",
            code: "UNKNOWN_TARGET",
            message: msg,
            retryable: false,
          })
          process.exitCode = 1
          return
        }
        throw new Error(msg)
      }
    }

    let selectedTargets = initialTargets
    const skippedTargets: string[] = []
    if (autoDetect) {
      const detections = await Promise.all(
        initialTargets.map(async (name) => ({
          name,
          detected: await isAgentDetected(name),
        })),
      )
      selectedTargets = detections.filter((d) => d.detected).map((d) => d.name)
      for (const { name, detected } of detections) {
        if (!detected) skippedTargets.push(name)
      }
    }

    if (autoDetect && selectedTargets.length === 0) {
      for (const name of skippedTargets) {
        emit({ type: "target_skipped", agent: name, reason: "not_detected" })
      }
      const pluginVersion = await readLocalPluginVersion()
      emit({
        type: "install_summary",
        pluginVersion,
        targetsTotal: 0,
        targetsSucceeded: 0,
        targetsFailed: 0,
        skillsTotal: 0,
        commandsTotal: 0,
        promptsTotal: 0,
        mcpServersTotal: 0,
      })
      if (!jsonMode) {
        const agents = Object.keys(AGENT_MARKERS).join(", ")
        console.log(
          "No supported AI coding tools detected in your home directory.",
        )
        console.log(`  Install one of: ${agents}.`)
        console.log(
          "  Or run with --to <target> to install anyway, or --to universal for the generic layout.",
        )
      }
      emit({ type: "install_completed", ok: true })
      return
    }

    // install_started is emitted after resolvePluginRoot so we have pluginVersion

    let pluginRoot: string
    let sourcePluginRoot: string
    let cloned: boolean
    try {
      const resolved = await resolvePluginRoot(jsonMode)
      sourcePluginRoot = resolved.pluginRoot
      cloned = resolved.cloned
      try {
        pluginRoot = await resolveInstallPluginRoot(sourcePluginRoot, method)
      } catch (err) {
        if (cloned) await fs.rm(sourcePluginRoot, { recursive: true, force: true }).catch(() => {})
        throw err
      }
    } catch (err) {
      if (jsonMode) {
        const message = err instanceof Error ? err.message : String(err)
        emit({
          type: "install_failed",
          code: "PLUGIN_RESOLVE_FAILED",
          message,
          retryable: true,
        })
        process.exitCode = 1
        return
      }
      throw err
    }

    const pluginVersion = await readPluginVersion(pluginRoot)

    emit({
      type: "install_started",
      mode: skillsOnly ? "skills-only" : "full",
      method,
      pluginVersion,
      target: targetName,
    })

    if (!jsonMode) {
      console.log(
        skillsOnly
          ? "Installing cubic skills...\n"
          : "Installing cubic plugin...\n",
      )
    }

    for (const name of skippedTargets) {
      emit({ type: "target_skipped", agent: name, reason: "not_detected" })
    }

    const results: ResultEntry[] = []

    const installPlans = await Promise.all(
      selectedTargets.map(async (name) => {
        const target = targets[name]
        const outputRoot = args.output
          ? path.resolve(String(args.output), name)
          : target.defaultRoot()
        const alreadyInstalled = !force
          && await isTargetAlreadyInstalled(
            name,
            outputRoot,
            skillsOnly,
            pluginRoot,
            pluginVersion,
            method,
          )
        return { name, outputRoot, alreadyInstalled }
      }),
    )

    try {
      for (const plan of installPlans) {
        const { name, outputRoot, alreadyInstalled } = plan
        const target = targets[name]
        await fs.mkdir(outputRoot, { recursive: true })

        emit({ type: "target_started", agent: name })

        try {
          let entry: ResultEntry

          if (alreadyInstalled) {
            entry = {
              agent: name,
              skills: 0,
              commands: 0,
              prompts: 0,
              mcpServers: 0,
              status: "ok",
              reason: "already installed",
            }
          } else if (skillsOnly) {
            const expectedEntries = await buildManifestEntries(
              pluginRoot,
              name,
              skillsOnly,
              method,
            )
            await cleanupObsoleteManagedEntries(name, outputRoot, expectedEntries)
            const layout = TARGET_LAYOUTS[name]
            if (!layout) {
              throw new Error(
                `No skills-only layout defined for target: ${name}. Add an entry to TARGET_LAYOUTS.`,
              )
            }
            const skills = await installSkills(
              pluginRoot,
              layout.skillsDir(outputRoot),
              method,
            )
            const commands = await installAllCommands(
              pluginRoot,
              layout.commandDir(outputRoot),
              layout,
              method,
            )
            entry = {
              agent: name,
              skills,
              commands,
              prompts: 0,
              mcpServers: 0,
              status: "ok",
              reason: null,
            }
          } else {
            const expectedEntries = await buildManifestEntries(
              pluginRoot,
              name,
              skillsOnly,
              method,
            )
            await cleanupObsoleteManagedEntries(name, outputRoot, expectedEntries)
            const tr = await target.install(pluginRoot, outputRoot, method)
            entry = {
              agent: name,
              ...tr,
              status: "ok",
              reason: null,
            }
          }
          results.push(entry)
          emit({ type: "target_result", method, ...entry })

          // Write manifest for this target
          if (entry.status === "ok" && entry.reason !== "already installed") {
            const manifestEntries = await buildManifestEntries(pluginRoot, name, skillsOnly, method)
            const manifest: CubicManifest = {
              manifestVersion: 1,
              pluginVersion,
              method,
              installedAt: new Date().toISOString(),
              target: name,
              ...(method === "symlink" ? { pluginRoot } : {}),
              entries: manifestEntries,
            }
            await writeManifest(outputRoot, manifest)
          }

          if (!jsonMode) {
            console.log(formatTargetLine(name, entry))
          }
        } catch (err) {
          const reason = err instanceof Error ? err.message : String(err)
          const entry: ResultEntry = {
            agent: name,
            skills: 0,
            commands: 0,
            prompts: 0,
            mcpServers: 0,
            status: "failed",
            reason,
          }
          results.push(entry)
          emit({ type: "target_result", method, ...entry })
          if (!jsonMode) console.log(`  ${name}: failed — ${reason}`)
        }
      }
    } finally {
      if (cloned) {
        await fs.rm(sourcePluginRoot, { recursive: true, force: true })
      }
    }

    const succeeded = results.filter((r) => r.status === "ok")
    const failed = results.filter((r) => r.status === "failed")
    const skipped = succeeded.filter((r) => r.reason === "already installed")

    emit({
      type: "install_summary",
      pluginVersion,
      targetsTotal: results.length,
      targetsSucceeded: succeeded.length,
      targetsFailed: failed.length,
      skillsTotal: results.reduce((s, r) => s + r.skills, 0),
      commandsTotal: results.reduce((s, r) => s + r.commands, 0),
      promptsTotal: results.reduce((s, r) => s + r.prompts, 0),
      mcpServersTotal: results.reduce((s, r) => s + r.mcpServers, 0),
    })

    const allFailed = failed.length > 0 && succeeded.length === 0

    if (allFailed) {
      emit({
        type: "install_failed",
        code: "TARGET_WRITE_FAILED",
        message: summarizeFailedTargets(failed),
        retryable: true,
      })
      process.exitCode = 1
      if (jsonMode) return
    } else {
      emit({ type: "install_completed", ok: true })
      if (jsonMode) return
    }

    if (failed.length > 0) {
      if (allFailed) {
        console.log("\nInstall failed. No targets were installed.")
      } else {
        console.log(
          "\n✓ Done with warnings. Restart your editor to use the targets that installed successfully.",
        )
      }
      console.log("  Failed targets:")
      for (const entry of failed) {
        console.log(`    - ${entry.agent}: ${entry.reason ?? "Unknown error"}`)
      }
    } else {
      if (skipped.length === results.length && results.length > 0) {
        console.log("\n✓ Already installed. Nothing changed.")
      } else if (skillsOnly) {
        console.log(
          "\n✓ Done! Restart your editor to start using cubic skills.",
        )
      } else {
        console.log("\n✓ Done! Restart your editor to start using cubic.")
      }
    }
  },
})
