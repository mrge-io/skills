import path from "path"
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
  mergeJsonConfig,
  removeMcpFromJsonConfig,
} from "../utils.js"

const CUBIC_COMMANDS = [
  "cubic-comments.md",
  "cubic-wiki.md",
  "cubic-scan.md",
  "cubic-learnings.md",
  "cubic-run-review.md",
]

export const cursor: Target = {
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
      const cmdTarget = path.join(outputRoot, "commands")
      await fs.mkdir(cmdTarget, { recursive: true })
      for (const file of await fs.readdir(cmdSource)) {
        if (!file.endsWith(".md")) continue
        const content = await fs.readFile(path.join(cmdSource, file), "utf-8")
        const { data, body } = parseFrontmatter(content)
        const stripped: Record<string, unknown> = {}
        if (data.description) stripped.description = data.description
        await fs.writeFile(
          path.join(cmdTarget, `cubic-${file}`),
          formatFrontmatter(stripped, body),
        )
        cmdCount++
      }
    }

    await mergeJsonConfig(path.join(outputRoot, "mcp.json"), {
      cubic: {
        url: "https://www.cubic.dev/api/mcp",
        headers: { Authorization: authHeader(apiKey) },
      },
    })


    return { skills: skillCount, commands: cmdCount, prompts: 0, mcpServers: 1 }
  },

  async uninstall(outputRoot: string): Promise<void> {
    await uninstallSkills(path.join(outputRoot, "skills"))
    for (const cmd of CUBIC_COMMANDS) {
      const p = path.join(outputRoot, "commands", cmd)
      if (await pathExists(p)) await fs.unlink(p)
    }
    await removeMcpFromJsonConfig(path.join(outputRoot, "mcp.json"), "cubic")
    console.log("  cursor: removed")
  },

  defaultRoot(): string {
    return path.join(process.cwd(), ".cursor")
  },
}
