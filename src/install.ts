import { defineCommand } from "citty"
import path from "path"
import { promises as fs } from "fs"
import {
  pathExists,
  inlineApiKey,
  resolvePluginRoot,
  resolveInstallPluginRoot,
  installReviewSkill,
  installReviewCommand,
  TARGET_LAYOUTS,
  readPluginVersion,
  readManifest,
  writeManifest,
  type InstallMethod,
  type ManifestEntry,
  type CubicManifest,
} from "./utils.js"
import { targets, TARGET_NAMES } from "./targets/index.js"
import { promptForApiKey } from "./key-setup.js"
import { createEmitter } from "./events.js"

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

async function jsonSectionHasMcpConfig(
  configPath: string,
  section: string,
  key: string,
): Promise<boolean> {
  const entry = await readJsonSectionEntry(configPath, section, key)
  if (!entry) return false
  const endpoint = typeof entry.url === "string"
    ? entry.url
    : typeof entry.baseUrl === "string"
    ? entry.baseUrl
    : undefined
  const headers = entry.headers
  const authHeader = typeof headers === "object"
    && headers !== null
    && !Array.isArray(headers)
    ? (headers as Record<string, unknown>).Authorization
    : undefined
  return typeof endpoint === "string"
    && endpoint.length > 0
    && typeof authHeader === "string"
    && authHeader.length > 0
}

async function fileHasTomlMcpConfig(
  filePath: string,
  section: string,
): Promise<boolean> {
  const sectionBody = await readActiveTomlSectionBody(filePath, section)
  if (!sectionBody) return false
  const httpHeaders = readTomlInlineTableBody(sectionBody, "http_headers")
  return /(^|\n)\s*url\s*=/.test(sectionBody)
    && httpHeaders !== null
    && /\bAuthorization\b\s*=/.test(httpHeaders)
}

function targetNeedsApiKey(name: string): boolean {
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
        path.join(outputRoot, "cubic", "mcporter.json"),
        "mcpServers",
        "cubic",
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

function expectedAuthHeader(apiKey: string): string {
  return `Bearer ${apiKey}`
}

async function jsonSectionHasAuthHeader(
  configPath: string,
  section: string,
  key: string,
  authHeader: string,
): Promise<boolean> {
  const entry = await readJsonSectionEntry(configPath, section, key)
  if (!entry) return false
  const headers = entry.headers
  if (typeof headers !== "object" || headers === null || Array.isArray(headers)) {
    return false
  }
  return (headers as Record<string, unknown>).Authorization === authHeader
}

async function fileHasTomlSectionAuthHeader(
  filePath: string,
  section: string,
  authHeader: string,
): Promise<boolean> {
  const sectionBody = await readActiveTomlSectionBody(filePath, section)
  if (!sectionBody) return false
  const httpHeaders = readTomlInlineTableBody(sectionBody, "http_headers")
  if (!httpHeaders) return false
  const escapedHeader = escapeRegExp(authHeader)
  const authPattern = new RegExp(
    `\\bAuthorization\\b\\s*=\\s*(?:"${escapedHeader}"|'${escapedHeader}')`,
  )
  return authPattern.test(httpHeaders)
}

async function targetHasApiKey(
  name: string,
  outputRoot: string,
  apiKey: string,
): Promise<boolean> {
  const authHeader = expectedAuthHeader(apiKey)
  switch (name) {
    case "claude":
      return jsonSectionHasAuthHeader(
        path.join(outputRoot, ".mcp.json"),
        "mcpServers",
        "cubic",
        authHeader,
      )
    case "cursor":
    case "droid":
      return jsonSectionHasAuthHeader(
        path.join(outputRoot, "mcp.json"),
        "mcpServers",
        "cubic",
        authHeader,
      )
    case "gemini":
      return jsonSectionHasAuthHeader(
        path.join(outputRoot, "settings.json"),
        "mcpServers",
        "cubic",
        authHeader,
      )
    case "opencode":
      return jsonSectionHasAuthHeader(
        path.join(outputRoot, "opencode.json"),
        "mcp",
        "cubic",
        authHeader,
      )
    case "pi":
      return jsonSectionHasAuthHeader(
        path.join(outputRoot, "cubic", "mcporter.json"),
        "mcpServers",
        "cubic",
        authHeader,
      )
    case "codex":
      return fileHasTomlSectionAuthHeader(
        path.join(outputRoot, "config.toml"),
        "mcp_servers.cubic",
        authHeader,
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
  apiKeyHint?: string,
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
      if (apiKeyHint && !(await targetHasApiKey(name, outputRoot, apiKeyHint))) {
        return false
      }
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
        // For skills-only mode, only run-review is installed
        if (skillsOnly && d.name !== "run-review") continue
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
      // For skills-only mode, only run-review command is installed
      if (skillsOnly && !file.includes("run-review")) continue
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
  if (!skillsOnly && targetNeedsApiKey(targetName)) {
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
        "Install only skills and commands (no MCP server or API key)",
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
    const selectedTargets =
      targetName === "all" ? TARGET_NAMES : [targetName]
    const skillsOnly = Boolean(args["skills-only"])
    const method = String(args.method) as InstallMethod
    const force = Boolean(args.force)
    const envApiKey = process.env.CUBIC_API_KEY?.startsWith("cbk_")
      ? process.env.CUBIC_API_KEY
      : undefined

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

    for (const name of selectedTargets) {
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

    const mcpPath = path.join(pluginRoot, ".mcp.json")
    let originalMcp: string | undefined

    if (!jsonMode) {
      console.log(
        skillsOnly
          ? "Installing cubic skills...\n"
          : "Installing cubic plugin...\n",
      )
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
            envApiKey,
          )
        return { name, outputRoot, alreadyInstalled }
      }),
    )

    let apiKey: string | undefined
    const needsAuth = !skillsOnly
      && installPlans.some((plan) => !plan.alreadyInstalled && targetNeedsApiKey(plan.name))
    if (needsAuth) {
      try {
        apiKey = await promptForApiKey(emit, jsonMode)
      } catch (err) {
        if (jsonMode) {
          const message = err instanceof Error ? err.message : String(err)
          emit({
            type: "install_failed",
            code: "AUTH_FAILED",
            message,
            retryable: true,
          })
          process.exitCode = 1
          return
        }
        throw err
      }
      if (jsonMode && !apiKey) {
        emit({
          type: "install_failed",
          code: "AUTH_REQUIRED",
          message:
            "JSON mode requires CUBIC_API_KEY in the environment. Passing the key over stdin is not supported.",
          retryable: true,
        })
        process.exitCode = 1
        return
      }
    }

    try {
      if (!skillsOnly && apiKey && (await pathExists(mcpPath))) {
        originalMcp = await fs.readFile(mcpPath, "utf-8")
        const mcpConfig = JSON.parse(originalMcp) as Record<string, unknown>
        inlineApiKey(mcpConfig, apiKey)
        await fs.writeFile(
          mcpPath,
          JSON.stringify(mcpConfig, null, 2) + "\n",
        )
      }

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
            const skillInstalled = await installReviewSkill(
              pluginRoot,
              layout.skillsDir(outputRoot),
              method,
            )
            const commandInstalled = await installReviewCommand(
              pluginRoot,
              layout.commandDir(outputRoot),
              layout,
              method,
            )
            const skills = skillInstalled ? 1 : 0
            const commands = commandInstalled ? 1 : 0
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
            const tr = await target.install(pluginRoot, outputRoot, apiKey, method)
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
            if (entry.reason === "already installed") {
              console.log(formatTargetLine(name, entry))
            } else if (skillsOnly) {
              console.log(`  ${name}: ${entry.skills} skill, ${entry.commands} command (skills only)`)
            } else {
              console.log(formatTargetLine(name, entry))
            }
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
      if (originalMcp) {
        await fs.writeFile(mcpPath, originalMcp)
      }
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

    if (failed.length > 0 && succeeded.length === 0) {
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
      if (skillsOnly) {
        console.log(
          "\n✓ Done with warnings. Restart your editor to use the targets that installed successfully.",
        )
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
      if (skipped.length === results.length) {
        console.log("\n✓ Already installed. Nothing changed.")
      } else if (skillsOnly) {
        console.log(
          "\n✓ Done! Restart your editor to start using cubic skills.",
        )
      } else if (!needsAuth || apiKey) {
        console.log("\n✓ Done! Restart your editor to start using cubic.")
      } else {
        console.log("\nNext steps:")
        console.log(
          "  1. Set your API key: export CUBIC_API_KEY=cbk_your_key_here",
        )
        console.log(
          "     Get one at: https://www.cubic.dev/settings?tab=integrations&integration=mcp",
        )
        console.log("  2. Restart your editor")
      }
    }
  },
})
