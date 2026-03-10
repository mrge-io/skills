import { describe, it, after } from "node:test"
import assert from "node:assert/strict"
import { execFile } from "node:child_process"
import { promisify } from "node:util"
import path from "node:path"
import { fileURLToPath } from "node:url"
import { rm } from "node:fs/promises"

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

  it("missing stdin input emits install_failed with AUTH_PROMPT_TIMEOUT", async () => {
    const outDir = path.join(TMP_BASE, "json-auth-timeout")

    try {
      await exec(
        "node",
        [
          CLI,
          "install",
          "--json",
          "--to",
          "claude",
          "-o",
          outDir,
        ],
        {
          env: {
            ...process.env,
            CUBIC_API_KEY: "",
            CUBIC_AUTH_PROMPT_TIMEOUT_MS: "1",
          },
          input: "",
          timeout: 5000,
        },
      )
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
      assert.equal(failed.code, "AUTH_PROMPT_TIMEOUT")
      assert.equal(failed.retryable, true)
    }
  })

  it("invalid clone timeout env falls back and installs in skills-only mode", async () => {
    const outDir = path.join(TMP_BASE, "json-invalid-clone-timeout")
    const { stdout } = await exec(
      "node",
      [
        CLI,
        "install",
        "--json",
        "--skills-only",
        "--to",
        "claude",
        "-o",
        outDir,
      ],
      {
        env: {
          ...process.env,
          CUBIC_PLUGIN_CLONE_TIMEOUT_MS: "not-a-number",
        },
      },
    )

    const events = stdout
      .trim()
      .split("\n")
      .map((l) => JSON.parse(l))

    const last = events[events.length - 1]
    assert.equal(last.type, "install_completed")
    assert.equal(last.ok, true)
  })

  it("overall install timeout emits install_failed with INSTALL_TIMEOUT", async () => {
    const outDir = path.join(TMP_BASE, "json-install-timeout")

    try {
      await exec(
        "node",
        [
          CLI,
          "install",
          "--json",
          "--skills-only",
          "--to",
          "claude",
          "-o",
          outDir,
        ],
        {
          env: {
            ...process.env,
            NODE_ENV: "test",
            CUBIC_INSTALL_TIMEOUT_MS: "20",
            CUBIC_TEST_INSTALL_DELAY_MS: "100",
          },
          timeout: 5000,
        },
      )
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
      assert.equal(failed.code, "INSTALL_TIMEOUT")
      assert.equal(failed.retryable, true)
    }
  })

  it("per-target timeout emits target_result failure and install_failed", async () => {
    const outDir = path.join(TMP_BASE, "json-target-timeout")

    try {
      await exec(
        "node",
        [
          CLI,
          "install",
          "--json",
          "--skills-only",
          "--to",
          "claude",
          "-o",
          outDir,
        ],
        {
          env: {
            ...process.env,
            NODE_ENV: "test",
            CUBIC_TARGET_INSTALL_TIMEOUT_MS: "20",
            CUBIC_TEST_TARGET_INSTALL_DELAY_MS: "100",
          },
          timeout: 5000,
        },
      )
      assert.fail("should have exited with non-zero code")
    } catch (err) {
      assert.ok(err.code !== 0, "exit code should be non-zero")
      const events = (err.stdout || "")
        .trim()
        .split("\n")
        .filter((l) => l)
        .map((l) => JSON.parse(l))

      const result = events.find((e) => e.type === "target_result")
      assert.ok(result)
      assert.equal(result.status, "failed")
      assert.match(result.reason, /Timed out while installing target 'claude'/)

      const failed = events.find((e) => e.type === "install_failed")
      assert.ok(failed)
      assert.equal(failed.code, "TARGET_WRITE_FAILED")
      assert.equal(failed.retryable, true)
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
