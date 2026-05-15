import path from "path"
import os from "os"
import { promises as fs } from "fs"
import type { Target, TargetResult } from "./index.js"
import type { InstallMethod } from "../utils.js"
import {
  parseFrontmatter,
  formatFrontmatter,
  pathExists,
  installSkills,
  uninstallSkills,
  mergeJsonConfig,
  removeMcpFromJsonConfig,
} from "../utils.js"

const CUBIC_PROMPTS = [
  "cubic-comments.md",
  "cubic-wiki.md",
  "cubic-scan.md",
  "cubic-learnings.md",
  "cubic-run-review.md",
]

export const pi: Target = {
  async install(pluginRoot: string, outputRoot: string, method: InstallMethod = "paste"): Promise<TargetResult> {
    const agentDir = path.join(outputRoot, ".pi", "agent")
    const skillCount = await installSkills(pluginRoot, path.join(agentDir, "skills"), method)

    const cmdSource = path.join(pluginRoot, "commands")
    let cmdCount = 0
    if (await pathExists(cmdSource)) {
      const promptsDir = path.join(agentDir, "prompts")
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

    await mergeJsonConfig(path.join(outputRoot, ".config", "mcp", "mcp.json"), {
      cubic: {
        auth: "oauth",
        url: "https://www.cubic.dev/api/mcp",
      },
    })


    return { skills: skillCount, commands: 0, prompts: cmdCount, mcpServers: 1 }
  },

  async uninstall(outputRoot: string): Promise<void> {
    const agentDir = path.join(outputRoot, ".pi", "agent")
    await uninstallSkills(path.join(agentDir, "skills"))
    for (const p of CUBIC_PROMPTS) {
      const fp = path.join(agentDir, "prompts", p)
      if (await pathExists(fp)) await fs.unlink(fp)
    }
    await removeMcpFromJsonConfig(path.join(outputRoot, ".config", "mcp", "mcp.json"), "cubic")
    const mcporterDir = path.join(agentDir, "cubic")
    if (await pathExists(mcporterDir)) await fs.rm(mcporterDir, { recursive: true })
    console.log("  pi: removed")
  },

  defaultRoot(): string {
    return os.homedir()
  },
}
