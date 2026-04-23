import path from "path"
import os from "os"
import { promises as fs } from "fs"
import type { Target, TargetResult } from "./index.js"
import { authHeader } from "./index.js"
import type { InstallMethod } from "../utils.js"
import {
  pathExists,
  installSkills,
  uninstallSkills,
  installFile,
  mergeJsonConfig,
  removeMcpFromJsonConfig,
} from "../utils.js"

const COMMANDS = ["comments.md", "wiki.md", "scan.md", "learnings.md", "run-review.md"]

export const claude: Target = {
  async install(pluginRoot: string, outputRoot: string, apiKey?: string, method: InstallMethod = "paste"): Promise<TargetResult> {
    await mergeJsonConfig(path.join(outputRoot, ".mcp.json"), {
      cubic: {
        type: "http",
        url: "https://www.cubic.dev/api/mcp",
        headers: { Authorization: authHeader(apiKey) },
      },
    })

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


    return { skills: skillCount, commands: cmdCount, prompts: 0, mcpServers: 1 }
  },

  async uninstall(outputRoot: string): Promise<void> {
    const claudeDir = path.join(outputRoot, ".claude")
    await uninstallSkills(path.join(claudeDir, "skills"))
    for (const cmd of COMMANDS) {
      const p = path.join(claudeDir, "commands", cmd)
      if (await pathExists(p)) await fs.unlink(p)
    }
    await removeMcpFromJsonConfig(path.join(outputRoot, ".mcp.json"), "cubic")
    console.log("  claude: removed")
  },

  defaultRoot(): string {
    return os.homedir()
  },
}
