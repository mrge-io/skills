import path from "path"
import os from "os"
import { promises as fs } from "fs"
import type { Target, TargetResult } from "./index.js"
import { authHeader } from "./index.js"
import type { InstallMethod } from "../utils.js"
import {
  parseFrontmatter,
  formatFrontmatter,
  pathExists,
  installSkills,
  uninstallSkills,
} from "../utils.js"

const CUBIC_PROMPTS = [
  "cubic-comments.md",
  "cubic-wiki.md",
  "cubic-scan.md",
  "cubic-learnings.md",
  "cubic-run-review.md",
]

export const codex: Target = {
  async install(
    pluginRoot: string,
    outputRoot: string,
    apiKey?: string,
    method: InstallMethod = "paste",
    _pluginMcpConfig?: Record<string, Record<string, unknown>>,
  ): Promise<TargetResult> {
    const skillCount = await installSkills(pluginRoot, path.join(outputRoot, "skills"), method)

    const cmdSource = path.join(pluginRoot, "commands")
    let cmdCount = 0
    if (await pathExists(cmdSource)) {
      const promptsDir = path.join(outputRoot, "prompts")
      await fs.mkdir(promptsDir, { recursive: true })
      for (const file of await fs.readdir(cmdSource)) {
        if (!file.endsWith(".md")) continue
        const content = await fs.readFile(path.join(cmdSource, file), "utf-8")
        const { data, body } = parseFrontmatter(content)
        const stripped: Record<string, unknown> = {}
        if (data.description) stripped.description = data.description
        await fs.writeFile(
          path.join(promptsDir, `cubic-${file}`),
          formatFrontmatter(stripped, body),
        )
        cmdCount++
      }
    }

    const configPath = path.join(outputRoot, "config.toml")
    const toml = [
      "[mcp_servers.cubic]",
      'url = "https://www.cubic.dev/api/mcp"',
      `http_headers = { Authorization = "${authHeader(apiKey)}" }`,
      "",
    ].join("\n")
    await fs.mkdir(outputRoot, { recursive: true })
    if (await pathExists(configPath)) {
      let existing = await fs.readFile(configPath, "utf-8")
      if (existing.includes("[mcp_servers.cubic]")) {
        existing = existing.replace(/\[mcp_servers\.cubic\][^\[]*/, "").trim()
      }
      const merged = existing.length > 0 ? existing.trimEnd() + "\n\n" + toml : toml
      await fs.writeFile(configPath, merged)
    } else {
      await fs.writeFile(configPath, toml)
    }


    return { skills: skillCount, commands: 0, prompts: cmdCount, mcpServers: 1 }
  },

  async uninstall(outputRoot: string): Promise<void> {
    await uninstallSkills(path.join(outputRoot, "skills"))
    for (const p of CUBIC_PROMPTS) {
      const fp = path.join(outputRoot, "prompts", p)
      if (await pathExists(fp)) await fs.unlink(fp)
    }
    const configPath = path.join(outputRoot, "config.toml")
    if (await pathExists(configPath)) {
      const content = await fs.readFile(configPath, "utf-8")
      if (content.includes("[mcp_servers.cubic]")) {
        const cleaned = content
          .replace(/\[mcp_servers\.cubic\][^\[]*/, "")
          .trim()
        if (cleaned.length === 0) {
          await fs.unlink(configPath)
        } else {
          await fs.writeFile(configPath, cleaned + "\n")
        }
      }
    }
    console.log("  codex: removed")
  },

  defaultRoot(): string {
    return path.join(os.homedir(), ".codex")
  },
}
