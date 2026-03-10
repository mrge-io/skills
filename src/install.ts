import { defineCommand } from "citty"
import path from "path"
import { promises as fs } from "fs"
import {
  pathExists,
  inlineApiKey,
  resolvePluginRoot,
  installReviewSkill,
  installReviewCommand,
  TARGET_LAYOUTS,
  readPluginVersion,
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

function formatTargetLine(name: string, r: ResultEntry): string {
  const parts = [`${r.skills} skills`]
  if (r.commands > 0) parts.push(`${r.commands} commands`)
  if (r.prompts > 0) parts.push(`${r.prompts} prompts`)
  if (r.mcpServers > 0)
    parts.push(`${r.mcpServers} MCP server${r.mcpServers !== 1 ? "s" : ""}`)
  return `  ${name}: ${parts.join(", ")}`
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
  if (!skillsOnly) {
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
  },
  async run({ args }) {
    const jsonMode = Boolean(args.json)
    const emit = createEmitter(jsonMode)
    const targetName = String(args.to)
    const selectedTargets =
      targetName === "all" ? TARGET_NAMES : [targetName]
    const skillsOnly = Boolean(args["skills-only"])
    const method = String(args.method) as InstallMethod

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

    let apiKey: string | undefined
    if (!skillsOnly) {
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
          message: "JSON mode requires CUBIC_API_KEY in the environment",
          retryable: true,
        })
        process.exitCode = 1
        return
      }
    }

    let pluginRoot: string
    let cloned: boolean
    try {
      const resolved = await resolvePluginRoot(jsonMode)
      pluginRoot = resolved.pluginRoot
      cloned = resolved.cloned
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

    if (method === "symlink" && cloned) {
      const msg = "Symlink requires a local plugin source. Use --method paste or clone the repo first."
      if (jsonMode) {
        emit({
          type: "install_failed",
          code: "SYMLINK_NO_LOCAL_SOURCE",
          message: msg,
          retryable: false,
        })
        process.exitCode = 1
        return
      }
      throw new Error(msg)
    }

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

      for (const name of selectedTargets) {
        const target = targets[name]
        const outputRoot = args.output
          ? path.resolve(String(args.output), name)
          : target.defaultRoot()
        await fs.mkdir(outputRoot, { recursive: true })

        emit({ type: "target_started", agent: name })

        try {
          let entry: ResultEntry

          if (skillsOnly) {
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
          if (entry.status === "ok") {
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
            if (skillsOnly) {
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
        await fs.rm(pluginRoot, { recursive: true, force: true })
      }
    }

    const succeeded = results.filter((r) => r.status === "ok")
    const failed = results.filter((r) => r.status === "failed")

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

    if (failed.length > 0) {
      emit({
        type: "install_failed",
        code: "TARGET_WRITE_FAILED",
        message: `${failed.length} target(s) failed`,
        retryable: true,
      })
      process.exitCode = 1
      if (jsonMode) return
    } else {
      emit({ type: "install_completed", ok: true })
      if (jsonMode) return
    }

    if (failed.length === 0) {
      if (skillsOnly) {
        console.log(
          "\n✓ Done! Restart your editor to start using cubic skills.",
        )
      } else if (apiKey) {
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
