import { describe, it, after } from "node:test"
import assert from "node:assert/strict"
import { execFile } from "node:child_process"
import { promisify } from "node:util"
import os from "node:os"
import path from "node:path"
import { fileURLToPath } from "node:url"
import { access, mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises"
import {
  CLAUDE_MCP_ADD_ARGV,
  CLAUDE_MCP_ADD_COMMAND,
  CLAUDE_MCP_REMOVE_ARGV,
  CUBIC_USER_SERVER,
  fakeClaudeHome,
} from "./fake-claude.mjs"

const exec = promisify(execFile)
const __dirname = path.dirname(fileURLToPath(import.meta.url))
const CLI = path.join(__dirname, "..", "dist", "index.js")
const TMP_BASE = await mkdtemp(path.join(os.tmpdir(), "cubic-plugin-claude-mcp-"))

const OTHER_SERVER = { command: "other-mcp", args: ["--stdio"] }

async function cleanup() {
  await rm(TMP_BASE, { recursive: true, force: true }).catch(() => {})
}

async function scenario(name, mode) {
  const fake = await fakeClaudeHome(path.join(TMP_BASE, name), mode)
  return {
    ...fake,
    legacyPath: path.join(fake.home, ".mcp.json"),
    skillPath: path.join(fake.home, ".claude", "skills", "run-review", "SKILL.md"),
    run(args, extraEnv = {}) {
      return exec(process.execPath, [CLI, ...args], { env: { ...fake.env, ...extraEnv } })
    },
  }
}

function targetResult(stdout) {
  return stdout
    .trim()
    .split("\n")
    .filter((line) => line)
    .map((line) => JSON.parse(line))
    .find((event) => event.type === "target_result")
}

async function exists(p) {
  try {
    await access(p)
    return true
  } catch {
    return false
  }
}

async function readJson(p) {
  return JSON.parse(await readFile(p, "utf-8"))
}

async function writeJson(p, value) {
  await mkdir(path.dirname(p), { recursive: true })
  await writeFile(p, JSON.stringify(value, null, 2) + "\n")
}

describe("claude MCP registration at the default root", () => {
  after(cleanup)

  it("registers cubic in the user config through claude mcp add and writes no ~/.mcp.json", async () => {
    const s = await scenario("add")

    const { stdout } = await s.run(["install", "--json", "--to", "claude"])

    const result = targetResult(stdout)
    assert.equal(result.status, "ok")
    assert.equal(result.reason, null)
    assert.equal(result.skills, 6)
    assert.equal(result.commands, 5)
    assert.equal(result.mcpServers, 1)
    assert.deepEqual(await s.calls(), [CLAUDE_MCP_ADD_ARGV])
    assert.equal(await exists(s.legacyPath), false)
    await access(s.skillPath)
  })

  it("treats a server that already exists in the user config as registered", async () => {
    const s = await scenario("add-exists")
    await s.run(["install", "--json", "--to", "claude"])

    const { stdout } = await s.run(
      ["install", "--json", "--to", "claude", "--force"],
      { FAKE_CLAUDE_MODE: "exists" },
    )

    const result = targetResult(stdout)
    assert.equal(result.status, "ok")
    assert.equal(result.reason, null)
    assert.equal(result.mcpServers, 1)
    assert.deepEqual(await s.calls(), [CLAUDE_MCP_ADD_ARGV, CLAUDE_MCP_ADD_ARGV])
  })

  it("fails the target when claude mcp add fails for any other reason", async () => {
    const s = await scenario("add-error", "error")

    const { code, stdout } = await s
      .run(["install", "--json", "--to", "claude"])
      .then((run) => ({ code: 0, stdout: run.stdout }), (err) => ({ code: err.code, stdout: err.stdout ?? "" }))

    assert.notEqual(code, 0, "install exits non-zero when its only target fails")
    const result = targetResult(stdout)
    assert.equal(result.status, "failed")
    assert.equal(result.mcpServers, 0)
    assert.match(result.reason, /simulated failure/)
  })

  it("still installs skills and commands when claude is not on PATH and names the command to run", async () => {
    const s = await scenario("add-missing", "missing")
    const legacy = { mcpServers: { cubic: CUBIC_USER_SERVER } }
    await writeJson(s.legacyPath, legacy)

    const { stdout } = await s.run(["install", "--json", "--to", "claude"])

    const result = targetResult(stdout)
    assert.equal(result.status, "ok")
    assert.equal(result.skills, 6)
    assert.equal(result.commands, 5)
    assert.equal(result.mcpServers, 0)
    assert.ok(
      result.reason?.includes(CLAUDE_MCP_ADD_COMMAND),
      `reason should name the command, got ${JSON.stringify(result.reason)}`,
    )
    await access(s.skillPath)
    assert.deepEqual(await readJson(s.legacyPath), legacy)
  })

  it("prints the command to run in text mode when claude is not on PATH", async () => {
    const s = await scenario("add-missing-text", "missing")

    const { stdout } = await s.run(["install", "--to", "claude"])

    assert.ok(stdout.includes("claude: 6 skills, 5 commands"), stdout)
    assert.ok(stdout.includes(CLAUDE_MCP_ADD_COMMAND), stdout)
    await access(s.skillPath)
  })

  it("removes the legacy ~/.mcp.json cubic entry it wrote and keeps everything else", async () => {
    const s = await scenario("legacy-others")
    await writeJson(s.legacyPath, {
      mcpServers: { cubic: CUBIC_USER_SERVER, other: OTHER_SERVER },
      unrelated: true,
    })

    await s.run(["install", "--json", "--to", "claude"])

    assert.deepEqual(await readJson(s.legacyPath), {
      mcpServers: { other: OTHER_SERVER },
      unrelated: true,
    })
  })

  it("deletes ~/.mcp.json when the cubic entry was all it held", async () => {
    const s = await scenario("legacy-only")
    await writeJson(s.legacyPath, { mcpServers: { cubic: CUBIC_USER_SERVER } })

    await s.run(["install", "--json", "--to", "claude"])

    assert.equal(await exists(s.legacyPath), false)
  })

  it("leaves a ~/.mcp.json cubic entry alone when it differs from the one it wrote", async () => {
    const s = await scenario("legacy-custom")
    const custom = {
      mcpServers: {
        cubic: { ...CUBIC_USER_SERVER, headers: { Authorization: "Bearer token" } },
      },
    }
    await writeJson(s.legacyPath, custom)

    await s.run(["install", "--json", "--to", "claude"])

    assert.deepEqual(await readJson(s.legacyPath), custom)
  })

  it("writes <dir>/.mcp.json for --output and never calls claude", async () => {
    const s = await scenario("custom-output")
    const outDir = path.join(TMP_BASE, "custom-output", "out")

    const { stdout } = await s.run(["install", "--json", "--to", "claude", "-o", outDir])

    const result = targetResult(stdout)
    assert.equal(result.status, "ok")
    assert.equal(result.mcpServers, 1)
    const config = await readJson(path.join(outDir, "claude", ".mcp.json"))
    assert.deepEqual(config.mcpServers.cubic, CUBIC_USER_SERVER)
    assert.deepEqual(await s.calls(), [])
    assert.equal(await exists(s.legacyPath), false)
  })
})

describe("claude already-installed check at the default root", () => {
  after(cleanup)

  it("reports already installed on a rerun when ~/.claude.json holds the cubic server", async () => {
    const s = await scenario("rerun")
    await s.run(["install", "--json", "--to", "claude"])

    const { stdout } = await s.run(["install", "--json", "--to", "claude"])

    const result = targetResult(stdout)
    assert.equal(result.status, "ok")
    assert.equal(result.reason, "already installed")
    assert.deepEqual(await s.calls(), [CLAUDE_MCP_ADD_ARGV])
  })

  it("cleans the legacy entry on a rerun after a missing claude and manual registration", async () => {
    const s = await scenario("rerun-legacy")
    const legacy = {
      mcpServers: { cubic: CUBIC_USER_SERVER, other: OTHER_SERVER },
      unrelated: true,
    }
    await writeJson(s.legacyPath, legacy)
    const first = targetResult((await s.run(
      ["install", "--json", "--to", "claude"],
      { PATH: "" },
    )).stdout)
    assert.equal(first.mcpServers, 0)
    assert.deepEqual(await readJson(s.legacyPath), legacy)

    await exec("claude", CLAUDE_MCP_ADD_ARGV, { env: s.env })
    const rerun = targetResult((await s.run(
      ["install", "--json", "--to", "claude"],
      { FAKE_CLAUDE_MODE: "exists" },
    )).stdout)

    assert.equal(rerun.status, "ok")
    assert.equal(rerun.reason, null)
    assert.equal(rerun.mcpServers, 1)
    assert.deepEqual(await readJson(s.legacyPath), {
      mcpServers: { other: OTHER_SERVER },
      unrelated: true,
    })
    const next = targetResult((await s.run(["install", "--json", "--to", "claude"])).stdout)
    assert.equal(next.reason, "already installed")
    assert.deepEqual(await s.calls(), [CLAUDE_MCP_ADD_ARGV, CLAUDE_MCP_ADD_ARGV])
  })

  it("still reports already installed when the legacy cubic entry is customized", async () => {
    const s = await scenario("rerun-custom-legacy")
    await s.run(["install", "--json", "--to", "claude"])
    const custom = {
      mcpServers: {
        cubic: { ...CUBIC_USER_SERVER, headers: { Authorization: "Bearer token" } },
      },
    }
    await writeJson(s.legacyPath, custom)

    const result = targetResult((await s.run(["install", "--json", "--to", "claude"])).stdout)

    assert.equal(result.reason, "already installed")
    assert.deepEqual(await readJson(s.legacyPath), custom)
    assert.deepEqual(await s.calls(), [CLAUDE_MCP_ADD_ARGV])
  })

  it("reads $CLAUDE_CONFIG_DIR/.claude.json when that variable is set", async () => {
    const s = await scenario("config-dir")
    const configDir = path.join(TMP_BASE, "config-dir", "claude-config")
    await mkdir(configDir, { recursive: true })
    const env = { CLAUDE_CONFIG_DIR: configDir }
    await s.run(["install", "--json", "--to", "claude"], env)
    await rm(path.join(s.home, ".claude.json"), { force: true })
    await writeJson(path.join(configDir, ".claude.json"), {
      mcpServers: { cubic: CUBIC_USER_SERVER },
    })

    const rerun = targetResult((await s.run(["install", "--json", "--to", "claude"], env)).stdout)
    assert.equal(rerun.reason, "already installed")

    await rm(path.join(configDir, ".claude.json"))
    const reinstall = targetResult((await s.run(["install", "--json", "--to", "claude"], env)).stdout)
    assert.equal(reinstall.reason, null)
    assert.equal(reinstall.mcpServers, 1)
    assert.deepEqual(await s.calls(), [CLAUDE_MCP_ADD_ARGV, CLAUDE_MCP_ADD_ARGV])
  })

  it("reinstalls when the user config cubic entry carries headers", async () => {
    const s = await scenario("rerun-headers")
    await s.run(["install", "--json", "--to", "claude"])
    await writeJson(path.join(s.home, ".claude.json"), {
      mcpServers: {
        cubic: { ...CUBIC_USER_SERVER, headers: { Authorization: "Bearer token" } },
      },
    })

    const { stdout } = await s.run(["install", "--json", "--to", "claude"])

    const result = targetResult(stdout)
    assert.equal(result.reason, null)
    assert.equal(result.mcpServers, 1)
    assert.deepEqual(await s.calls(), [CLAUDE_MCP_ADD_ARGV, CLAUDE_MCP_ADD_ARGV])
  })
})

describe("claude uninstall at the default root", () => {
  after(cleanup)

  it("removes the user config entry through claude mcp remove and the legacy ~/.mcp.json entry", async () => {
    const s = await scenario("uninstall")
    await s.run(["install", "--json", "--to", "claude"])
    await writeJson(s.legacyPath, {
      mcpServers: { cubic: CUBIC_USER_SERVER, other: OTHER_SERVER },
    })

    await s.run(["uninstall", "--to", "claude"])

    assert.deepEqual(await s.calls(), [CLAUDE_MCP_ADD_ARGV, CLAUDE_MCP_REMOVE_ARGV])
    assert.equal(await exists(s.skillPath), false)
    assert.equal(await exists(path.join(s.home, ".claude", "commands", "comments.md")), false)
    assert.deepEqual(await readJson(s.legacyPath), { mcpServers: { other: OTHER_SERVER } })
  })

  it("succeeds when claude reports no cubic server in the user scope", async () => {
    const s = await scenario("uninstall-absent")
    await s.run(["install", "--json", "--to", "claude"])

    await s.run(["uninstall", "--to", "claude"], { FAKE_CLAUDE_MODE: "absent" })

    assert.equal(await exists(s.skillPath), false)
  })

  it("succeeds when claude is not on PATH", async () => {
    const s = await scenario("uninstall-missing", "missing")
    await s.run(["install", "--json", "--to", "claude"])
    await access(s.skillPath)

    await s.run(["uninstall", "--to", "claude"])

    assert.equal(await exists(s.skillPath), false)
  })
})
