import { describe, it, after } from "node:test"
import assert from "node:assert/strict"
import { execFile } from "node:child_process"
import { promisify } from "node:util"
import path from "node:path"
import { fileURLToPath } from "node:url"
import { access, mkdir, rm, writeFile } from "node:fs/promises"
import { pathToFileURL } from "node:url"

const exec = promisify(execFile)
const __dirname = path.dirname(fileURLToPath(import.meta.url))
const CLI = path.join(__dirname, "..", "dist", "index.js")
const TMP_BASE = path.join(__dirname, "..", ".test-output")

async function cleanup() {
  await rm(TMP_BASE, { recursive: true, force: true }).catch(() => {})
}

describe("install --json --skills-only", () => {
  after(cleanup)

  it("produces valid NDJSON on stdout for a single target", async () => {
    const outDir = path.join(TMP_BASE, "json-single")
    const { stdout } = await exec("node", [
      CLI,
      "install",
      "--json",
      "--skills-only",
      "--to",
      "claude",
      "-o",
      outDir,
    ])

    const lines = stdout.trim().split("\n")
    assert.ok(lines.length >= 4, `expected >=4 lines, got ${lines.length}`)

    const events = lines.map((l) => JSON.parse(l))

    assert.equal(events[0].type, "install_started")
    assert.equal(events[0].mode, "skills-only")
    assert.equal(events[0].target, "claude")
    assert.equal(events[0].version, 1)

    const started = events.find((e) => e.type === "target_started")
    assert.ok(started)
    assert.equal(started.agent, "claude")

    const result = events.find((e) => e.type === "target_result")
    assert.ok(result)
    assert.equal(result.agent, "claude")
    assert.equal(result.status, "ok")
    assert.equal(result.skills, 1)
    assert.equal(result.commands, 1)
    assert.equal(result.mcpServers, 0)

    const summary = events.find((e) => e.type === "install_summary")
    assert.ok(summary)
    assert.equal(summary.targetsTotal, 1)
    assert.equal(summary.targetsSucceeded, 1)
    assert.equal(summary.targetsFailed, 0)

    const last = events[events.length - 1]
    assert.equal(last.type, "install_completed")
    assert.equal(last.ok, true)

    const runIds = new Set(events.map((e) => e.runId))
    assert.equal(runIds.size, 1, "all events share a single runId")
  })

  it("produces valid NDJSON for all targets", async () => {
    const outDir = path.join(TMP_BASE, "json-all")
    const { stdout } = await exec("node", [
      CLI,
      "install",
      "--json",
      "--skills-only",
      "--to",
      "all",
      "-o",
      outDir,
    ])

    const events = stdout
      .trim()
      .split("\n")
      .map((l) => JSON.parse(l))

    assert.equal(events[0].type, "install_started")
    assert.equal(events[0].target, "all")

    const results = events.filter((e) => e.type === "target_result")
    assert.equal(results.length, 8, "one result per target")

    const summary = events.find((e) => e.type === "install_summary")
    assert.equal(summary.targetsTotal, 8)
    assert.equal(summary.skillsTotal, 8)
    assert.equal(summary.commandsTotal, 8)
  })

  it("each NDJSON line is valid JSON parseable by jq", async () => {
    const outDir = path.join(TMP_BASE, "json-jq")
    const { stdout } = await exec("node", [
      CLI,
      "install",
      "--json",
      "--skills-only",
      "--to",
      "claude",
      "-o",
      outDir,
    ])

    for (const line of stdout.trim().split("\n")) {
      assert.doesNotThrow(() => JSON.parse(line), `Invalid JSON line: ${line}`)
    }
  })

  it("stdout contains zero non-JSON lines", async () => {
    const outDir = path.join(TMP_BASE, "json-pure")
    const { stdout } = await exec("node", [
      CLI,
      "install",
      "--json",
      "--skills-only",
      "--to",
      "claude",
      "-o",
      outDir,
    ])

    for (const line of stdout.trim().split("\n")) {
      const parsed = JSON.parse(line)
      assert.ok(parsed.type, `line missing 'type' field: ${line}`)
      assert.equal(parsed.version, 1, "all events have version 1")
    }
  })
})

describe("install --json error paths", () => {
  it("unknown target emits install_failed with UNKNOWN_TARGET", async () => {
    try {
      await exec("node", [
        CLI,
        "install",
        "--json",
        "--to",
        "nonexistent",
      ])
      assert.fail("should have exited with non-zero code")
    } catch (err) {
      assert.ok(err.code !== 0, "exit code should be non-zero")
      const events = (err.stdout || "")
        .trim()
        .split("\n")
        .filter((l) => l)
        .map((l) => JSON.parse(l))
      const failed = events.find((e) => e.type === "install_failed")
      assert.ok(failed)
      assert.equal(failed.code, "UNKNOWN_TARGET")
      assert.equal(failed.retryable, false)
    }
  })
})

describe("install text mode (backward compatibility)", () => {
  after(cleanup)

  it("produces human-readable output with no JSON events", async () => {
    const outDir = path.join(TMP_BASE, "text-mode")
    const { stdout } = await exec("node", [
      CLI,
      "install",
      "--skills-only",
      "--to",
      "claude",
      "-o",
      outDir,
    ])

    assert.ok(stdout.includes("Installing cubic skills"), "has progress text")
    assert.ok(
      stdout.includes("claude: 1 skill, 1 command"),
      "has target summary",
    )
    assert.ok(stdout.includes("Done!"), "has completion message")

    for (const line of stdout.trim().split("\n")) {
      if (!line.trim()) continue
      let isJson = false
      try {
        const parsed = JSON.parse(line)
        if (parsed.type && parsed.version) isJson = true
      } catch {
        /* expected */
      }
      assert.ok(!isJson, `unexpected JSON event in text mode: ${line}`)
    }
  })
})

describe("uninstallSkills", () => {
  after(cleanup)

  it("removes cubic-loop along with the existing cubic skills", async () => {
    const skillsDir = path.join(TMP_BASE, "uninstall-skills", "skills")
    const skillNames = [
      "review-patterns",
      "codebase-context",
      "check-pr-comments",
      "review-and-fix-issues",
      "run-review",
      "cubic-loop",
    ]

    for (const skill of skillNames) {
      const dir = path.join(skillsDir, skill)
      await mkdir(dir, { recursive: true })
      await writeFile(path.join(dir, "SKILL.md"), `name: ${skill}\n`)
    }

    const utils = await import(
      pathToFileURL(path.join(__dirname, "..", "dist", "utils.js")).href
    )

    const removed = await utils.uninstallSkills(skillsDir)
    assert.equal(removed, skillNames.length)

    for (const skill of skillNames) {
      await assert.rejects(
        access(path.join(skillsDir, skill)),
      )
    }
  })
})

describe("installSkills", () => {
  after(cleanup)

  it("removes the legacy review-and-fix-issues directory when check-pr-comments is installed", async () => {
    const skillsDir = path.join(TMP_BASE, "install-skills", "skills")
    const legacyDir = path.join(skillsDir, "review-and-fix-issues")
    const pluginRoot = path.join(__dirname, "..")

    await mkdir(legacyDir, { recursive: true })
    await writeFile(path.join(legacyDir, "SKILL.md"), "name: review-and-fix-issues\n")

    const utils = await import(
      pathToFileURL(path.join(__dirname, "..", "dist", "utils.js")).href
    )

    const count = await utils.installSkills(pluginRoot, skillsDir)
    assert.ok(count >= 5)

    await assert.rejects(access(legacyDir))
    await access(path.join(skillsDir, "check-pr-comments", "SKILL.md"))
  })
})

describe("resolveInstallPluginRoot", () => {
  after(cleanup)

  it("materializes ephemeral npx plugin roots into a stable home directory for symlink installs", async () => {
    const homeDir = path.join(TMP_BASE, "stable-home")
    const pluginRoot = path.join(
      TMP_BASE,
      "ephemeral",
      ".npm",
      "_npx",
      "cache123",
      "node_modules",
      "@cubic-plugin",
      "cubic-plugin",
    )

    await mkdir(path.join(pluginRoot, "skills", "check-pr-comments"), { recursive: true })
    await writeFile(path.join(pluginRoot, "skills", "check-pr-comments", "SKILL.md"), "name: check-pr-comments\n")
    await writeFile(path.join(pluginRoot, ".mcp.json"), "{}\n")
    await writeFile(path.join(pluginRoot, "package.json"), JSON.stringify({ name: "@cubic-plugin/cubic-plugin", version: "1.3.1" }))

    const utils = await import(
      pathToFileURL(path.join(__dirname, "..", "dist", "utils.js")).href
    )

    const stableRoot = await utils.resolveInstallPluginRoot(pluginRoot, "symlink", { homeDir })
    const expectedRoot = path.join(homeDir, ".cubic-plugin", "plugin-source")

    assert.equal(stableRoot, expectedRoot)
    await access(path.join(expectedRoot, "skills", "check-pr-comments", "SKILL.md"))
    await access(path.join(expectedRoot, ".mcp.json"))
  })

  it("keeps local repository plugin roots unchanged for symlink installs", async () => {
    const homeDir = path.join(TMP_BASE, "local-home")
    const pluginRoot = path.join(TMP_BASE, "local-plugin-root")

    await mkdir(path.join(pluginRoot, "skills", "check-pr-comments"), { recursive: true })
    await writeFile(path.join(pluginRoot, "skills", "check-pr-comments", "SKILL.md"), "name: check-pr-comments\n")
    await writeFile(path.join(pluginRoot, ".mcp.json"), "{}\n")
    await writeFile(path.join(pluginRoot, "package.json"), JSON.stringify({ name: "@cubic-plugin/cubic-plugin", version: "1.3.1" }))

    const utils = await import(
      pathToFileURL(path.join(__dirname, "..", "dist", "utils.js")).href
    )

    const resolvedRoot = await utils.resolveInstallPluginRoot(pluginRoot, "symlink", { homeDir })
    assert.equal(resolvedRoot, pluginRoot)
  })
})
