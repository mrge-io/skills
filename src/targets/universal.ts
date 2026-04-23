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
} from "../utils.js"

const CUBIC_COMMANDS = [
  "cubic-comments.md",
  "cubic-wiki.md",
  "cubic-scan.md",
  "cubic-learnings.md",
  "cubic-run-review.md",
]

export const universal: Target = {
  async install(pluginRoot: string, outputRoot: string, _apiKey?: string, method: InstallMethod = "paste"): Promise<TargetResult> {
    const agentsDir = path.join(outputRoot, ".agents")
    const skillCount = await installSkills(pluginRoot, path.join(agentsDir, "skills"), method)

    const cmdSource = path.join(pluginRoot, "commands")
    let cmdCount = 0
    if (await pathExists(cmdSource)) {
      const cmdTarget = path.join(agentsDir, "commands")
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

    return { skills: skillCount, commands: cmdCount, prompts: 0, mcpServers: 0 }
  },

  async uninstall(outputRoot: string): Promise<void> {
    const agentsDir = path.join(outputRoot, ".agents")
    await uninstallSkills(path.join(agentsDir, "skills"))
    for (const cmd of CUBIC_COMMANDS) {
      const p = path.join(agentsDir, "commands", cmd)
      if (await pathExists(p)) await fs.unlink(p)
    }
    console.log("  universal: removed")
  },

  defaultRoot(): string {
    return os.homedir()
  },
}
