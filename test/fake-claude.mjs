import path from "node:path"
import { mkdir, readFile, writeFile } from "node:fs/promises"

export const CUBIC_MCP_URL = "https://www.cubic.dev/api/mcp"
export const CLAUDE_MCP_ADD_ARGV = [
  "mcp", "add", "--scope", "user", "--transport", "http", "cubic", CUBIC_MCP_URL,
]
export const CLAUDE_MCP_REMOVE_ARGV = ["mcp", "remove", "cubic", "--scope", "user"]
export const CLAUDE_MCP_ADD_COMMAND = `claude ${CLAUDE_MCP_ADD_ARGV.join(" ")}`
export const CUBIC_USER_SERVER = { type: "http", url: CUBIC_MCP_URL }

const ARGV_SEPARATOR = "\x1f"

const SCRIPT = `#!/bin/sh
printf '%s${ARGV_SEPARATOR}' "$@" >> "$FAKE_CLAUDE_LOG"
printf '\\n' >> "$FAKE_CLAUDE_LOG"
case "\${FAKE_CLAUDE_MODE:-ok}" in
  ok) ;;
  exists) echo "MCP server cubic already exists in user config" >&2; exit 1 ;;
  absent) echo 'No MCP server named "cubic" in user scope' >&2; exit 1 ;;
  error) echo "simulated failure" >&2; exit 1 ;;
  *) echo "fake claude: unknown FAKE_CLAUDE_MODE $FAKE_CLAUDE_MODE" >&2; exit 2 ;;
esac
if [ "$2" = "add" ]; then
  printf '{"mcpServers":{"cubic":{"type":"http","url":"${CUBIC_MCP_URL}"}}}\\n' > "\${CLAUDE_CONFIG_DIR:-$HOME}/.claude.json"
fi
exit 0
`

export async function fakeClaudeHome(root, mode = "ok") {
  const home = path.join(root, "home")
  const bin = path.join(root, "bin")
  const log = path.join(root, "claude-argv.log")
  await mkdir(home, { recursive: true })
  await mkdir(bin, { recursive: true })
  if (mode !== "missing") {
    await writeFile(path.join(bin, "claude"), SCRIPT, { mode: 0o755 })
  }
  const env = { ...process.env, HOME: home, PATH: bin, FAKE_CLAUDE_LOG: log }
  delete env.CLAUDE_CONFIG_DIR
  if (mode !== "ok" && mode !== "missing") env.FAKE_CLAUDE_MODE = mode
  return {
    home,
    env,
    async calls() {
      let content
      try {
        content = await readFile(log, "utf-8")
      } catch {
        return []
      }
      return content
        .split("\n")
        .filter((line) => line)
        .map((line) => line.split(ARGV_SEPARATOR).filter((arg) => arg))
    },
  }
}
