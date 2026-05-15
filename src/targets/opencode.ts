import path from "path"
import os from "os"
import { promises as fs } from "fs"
import type { Target, TargetResult } from "./index.js"
import type { InstallMethod } from "../utils.js"
import {
  parseFrontmatter,
  formatFrontmatter,
  convertMcpConfig,
  pathExists,
  readJson,
  mergeOpenCodeConfig,
  removeMcpFromConfig,
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

export const opencode: Target = {
  async install(pluginRoot: string, outputRoot: string, method: InstallMethod = "paste"): Promise<TargetResult> {
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

    const mcpPath = path.join(pluginRoot, ".mcp.json")
    if (await pathExists(mcpPath)) {
      const mcpConfig = await readJson(mcpPath)
      const converted = convertMcpConfig(mcpConfig as Record<string, Record<string, unknown>>)
      await mergeOpenCodeConfig(path.join(outputRoot, "opencode.json"), { mcp: converted })
    }


    return { skills: skillCount, commands: cmdCount, prompts: 0, mcpServers: (await pathExists(mcpPath)) ? 1 : 0 }
  },

  async uninstall(outputRoot: string): Promise<void> {
    await uninstallSkills(path.join(outputRoot, "skills"))
    for (const cmd of CUBIC_COMMANDS) {
      const p = path.join(outputRoot, "commands", cmd)
      if (await pathExists(p)) await fs.unlink(p)
    }
    await removeMcpFromConfig(path.join(outputRoot, "opencode.json"))
    console.log("  opencode: removed")
  },

  defaultRoot(): string {
    return path.join(os.homedir(), ".config", "opencode")
  },
}
