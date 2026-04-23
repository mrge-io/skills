import { describe, it, after } from "node:test"
import assert from "node:assert/strict"
import { execFile } from "node:child_process"
import os from "node:os"
import { promisify } from "node:util"
import path from "node:path"
import { fileURLToPath } from "node:url"
import { access, mkdir, readFile, rm, writeFile } from "node:fs/promises"
import { pathToFileURL } from "node:url"

const exec = promisify(execFile)
const __dirname = path.dirname(fileURLToPath(import.meta.url))
const CLI = path.join(__dirname, "..", "dist", "index.js")
const CLEAN_HOME_SCRIPT = path.join(__dirname, "..", "scripts", "clean-home-install.mjs")
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
  after(cleanup)

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

  it("explains that json auth must come from the environment", async () => {
    const outDir = path.join(TMP_BASE, "json-auth-required")

    try {
      await exec("node", [
        CLI,
        "install",
        "--json",
        "--to",
        "claude",
        "-o",
        outDir,
      ])
      assert.fail("should have exited with non-zero code")
    } catch (err) {
      assert.ok(err.code !== 0, "exit code should be non-zero")
      const events = (err.stdout || "")
        .trim()
        .split("\n")
        .filter((l) => l)
        .map((l) => JSON.parse(l))

      const warning = events.find((e) => e.type === "auth_warning")
      assert.ok(warning)
      assert.match(warning.message, /CUBIC_API_KEY/)
      assert.match(warning.message, /stdin is not supported/i)

      const failed = events.find((e) => e.type === "install_failed")
      assert.ok(failed)
      assert.equal(failed.code, "AUTH_REQUIRED")
      assert.match(failed.message, /CUBIC_API_KEY/)
      assert.match(failed.message, /stdin is not supported/i)
    }
  })

  it("reports invalid existing JSON config with the failing path", async () => {
    const outDir = path.join(TMP_BASE, "json-invalid-config")
    const configPath = path.join(outDir, "cursor", "mcp.json")

    await mkdir(path.dirname(configPath), { recursive: true })
    await writeFile(configPath, '{\n  "mcpServers": {\n    "cubic": \n')

    try {
      await exec("node", [
        CLI,
        "install",
        "--json",
        "--to",
        "cursor",
        "-o",
        outDir,
      ], {
        env: {
          ...process.env,
          CUBIC_API_KEY: "cbk_test_key",
        },
      })
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
      assert.equal(result.agent, "cursor")
      assert.equal(result.status, "failed")
      assert.match(result.reason, /Invalid JSON/)
      assert.match(result.reason, new RegExp(configPath.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")))

      const failed = events.find((e) => e.type === "install_failed")
      assert.ok(failed)
      assert.equal(failed.code, "TARGET_WRITE_FAILED")
      assert.match(failed.message, /^cursor failed: Invalid JSON/)
      assert.match(failed.message, new RegExp(configPath.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")))
    }
  })

  it("treats partial target failures as an overall success", async () => {
    const outDir = path.join(TMP_BASE, "json-partial-success")
    const cursorConfigPath = path.join(outDir, "cursor", "mcp.json")

    await mkdir(path.dirname(cursorConfigPath), { recursive: true })
    await writeFile(cursorConfigPath, '{\n  "mcpServers": {\n    "cubic": \n')

    const { stdout } = await exec("node", [
      CLI,
      "install",
      "--json",
      "--to",
      "all",
      "-o",
      outDir,
    ], {
      env: {
        ...process.env,
        CUBIC_API_KEY: "cbk_test_key",
      },
    })

    const events = stdout
      .trim()
      .split("\n")
      .filter((l) => l)
      .map((l) => JSON.parse(l))

    const cursorResult = events.find(
      (e) => e.type === "target_result" && e.agent === "cursor",
    )
    assert.ok(cursorResult)
    assert.equal(cursorResult.status, "failed")

    const successResults = events.filter(
      (e) => e.type === "target_result" && e.status === "ok",
    )
    assert.ok(successResults.length > 0, "other targets should still install")

    const summary = events.find((e) => e.type === "install_summary")
    assert.ok(summary)
    assert.equal(summary.targetsTotal, 8)
    assert.equal(summary.targetsFailed, 1)
    assert.equal(summary.targetsSucceeded, 7)

    const completed = events.find((e) => e.type === "install_completed")
    assert.ok(completed, "partial success should still complete successfully")

    const failed = events.find((e) => e.type === "install_failed")
    assert.equal(failed, undefined, "partial success should not emit install_failed")
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

  it("does not show API key setup steps when the target does not require auth", async () => {
    const outDir = path.join(TMP_BASE, "text-mode-universal")
    const { stdout } = await exec("node", [
      CLI,
      "install",
      "--to",
      "universal",
      "-o",
      outDir,
    ])

    assert.ok(
      stdout.includes("Done! Restart your editor to start using cubic."),
      "shows the normal completion message",
    )
    assert.equal(
      stdout.includes("Set your API key"),
      false,
      "should not suggest API key setup when auth was not needed",
    )
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

describe("target default roots", () => {
  it("installs user-level targets under the home directory", async () => {
    const { targets } = await import(
      pathToFileURL(path.join(__dirname, "..", "dist", "targets", "index.js")).href
    )

    assert.equal(targets.claude.defaultRoot(), os.homedir())
    assert.equal(targets.cursor.defaultRoot(), path.join(os.homedir(), ".cursor"))
    assert.equal(targets.gemini.defaultRoot(), path.join(os.homedir(), ".gemini"))
    assert.equal(targets.universal.defaultRoot(), os.homedir())
  })
})

describe("install skip behavior", () => {
  after(cleanup)

  it("skips reinstalling an already installed target before auth", async () => {
    const outDir = path.join(TMP_BASE, "skip-installed")

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
          CUBIC_API_KEY: "cbk_test_key",
        },
      },
    )

    const { stdout } = await exec("node", [
      CLI,
      "install",
      "--json",
      "--to",
      "claude",
      "-o",
      outDir,
    ])

    const events = stdout
      .trim()
      .split("\n")
      .filter((line) => line)
      .map((line) => JSON.parse(line))

    assert.equal(
      events.some((event) => event.type === "auth_required"),
      false,
      "should not prompt for auth when target is already installed",
    )

    const result = events.find((event) => event.type === "target_result")
    assert.ok(result)
    assert.equal(result.status, "ok")
    assert.equal(result.reason, "already installed")
    assert.equal(result.skills, 0)
    assert.equal(result.commands, 0)
    assert.equal(result.mcpServers, 0)

    const completed = events.find((event) => event.type === "install_completed")
    assert.ok(completed)
    assert.equal(completed.ok, true)
  })

  it("reinstalls when the provided API key differs from the installed one", async () => {
    const outDir = path.join(TMP_BASE, "skip-rotated-key")

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
          CUBIC_API_KEY: "cbk_old_key",
        },
      },
    )

    const { stdout } = await exec(
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
          CUBIC_API_KEY: "cbk_new_key",
        },
      },
    )

    const events = stdout
      .trim()
      .split("\n")
      .filter((line) => line)
      .map((line) => JSON.parse(line))

    assert.equal(
      events.some((event) => event.type === "auth_required"),
      true,
      "should request auth when the provided key differs",
    )

    const result = events.find((event) => event.type === "target_result")
    assert.ok(result)
    assert.equal(result.status, "ok")
    assert.equal(result.reason, null)
    assert.equal(result.mcpServers, 1)

    const installedConfig = await readFile(
      path.join(outDir, "claude", ".mcp.json"),
      "utf-8",
    )
    assert.ok(installedConfig.includes("cbk_new_key"))
    assert.equal(installedConfig.includes("cbk_old_key"), false)
  })

  it("does not skip partially broken installs", async () => {
    const outDir = path.join(TMP_BASE, "skip-partial-install")

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
          CUBIC_API_KEY: "cbk_test_key",
        },
      },
    )

    await rm(
      path.join(outDir, "claude", ".claude", "skills", "cubic-loop", "SKILL.md"),
      { force: true },
    )

    try {
      await exec("node", [
        CLI,
        "install",
        "--json",
        "--to",
        "claude",
        "-o",
        outDir,
      ])
      assert.fail("should require auth because the install is incomplete")
    } catch (err) {
      assert.ok(err.code !== 0, "exit code should be non-zero")

      const events = (err.stdout || "")
        .trim()
        .split("\n")
        .filter((line) => line)
        .map((line) => JSON.parse(line))

      assert.equal(
        events.some((event) => event.type === "auth_required"),
        true,
        "should prompt for auth when required files are missing",
      )
      assert.equal(
        events.some((event) => event.type === "target_result" && event.reason === "already installed"),
        false,
        "should not report the target as already installed",
      )

      const failed = events.find((event) => event.type === "install_failed")
      assert.ok(failed)
      assert.equal(failed.code, "AUTH_REQUIRED")
    }
  })

  it("skips repeated full installs for targets that do not need auth", async () => {
    const outDir = path.join(TMP_BASE, "skip-universal-full")

    await exec("node", [
      CLI,
      "install",
      "--json",
      "--to",
      "universal",
      "-o",
      outDir,
    ])

    const { stdout } = await exec("node", [
      CLI,
      "install",
      "--json",
      "--to",
      "universal",
      "-o",
      outDir,
    ])

    const events = stdout
      .trim()
      .split("\n")
      .filter((line) => line)
      .map((line) => JSON.parse(line))

    assert.equal(
      events.some((event) => event.type === "auth_required"),
      false,
      "should not prompt for auth for universal installs",
    )

    const result = events.find((event) => event.type === "target_result")
    assert.ok(result)
    assert.equal(result.status, "ok")
    assert.equal(result.reason, "already installed")
  })

  it("reinstalls and prunes stale managed files when the manifest is out of date", async () => {
    const outDir = path.join(TMP_BASE, "skip-stale-manifest")

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
          CUBIC_API_KEY: "cbk_test_key",
        },
      },
    )

    const manifestPath = path.join(outDir, "claude", ".cubic-manifest.claude.json")
    const manifest = JSON.parse(await readFile(manifestPath, "utf-8"))
    manifest.pluginVersion = "0.0.0"
    manifest.entries.push({
      name: "obsolete-skill",
      type: "skill",
      file: path.join("skills", "obsolete-skill", "SKILL.md"),
      method: "paste",
    })
    await writeFile(manifestPath, JSON.stringify(manifest, null, 2) + "\n")

    const obsoleteSkill = path.join(
      outDir,
      "claude",
      ".claude",
      "skills",
      "obsolete-skill",
      "SKILL.md",
    )
    await mkdir(path.dirname(obsoleteSkill), { recursive: true })
    await writeFile(obsoleteSkill, "name: obsolete-skill\n")

    const { stdout } = await exec(
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
          CUBIC_API_KEY: "cbk_test_key",
        },
      },
    )

    const events = stdout
      .trim()
      .split("\n")
      .filter((line) => line)
      .map((line) => JSON.parse(line))

    const result = events.find((event) => event.type === "target_result")
    assert.ok(result)
    assert.equal(result.status, "ok")
    assert.equal(result.reason, null)
    assert.ok(result.skills > 0)
    await assert.rejects(access(path.dirname(obsoleteSkill)))
  })

  it("does not treat malformed JSON MCP entries as already installed", async () => {
    const outDir = path.join(TMP_BASE, "skip-malformed-json-mcp")

    await exec(
      "node",
      [
        CLI,
        "install",
        "--json",
        "--to",
        "cursor",
        "-o",
        outDir,
      ],
      {
        env: {
          ...process.env,
          CUBIC_API_KEY: "cbk_test_key",
        },
      },
    )

    const configPath = path.join(outDir, "cursor", "mcp.json")
    const config = JSON.parse(await readFile(configPath, "utf-8"))
    config.mcpServers.cubic = null
    await writeFile(configPath, JSON.stringify(config, null, 2) + "\n")

    const { stdout } = await exec(
      "node",
      [
        CLI,
        "install",
        "--json",
        "--to",
        "cursor",
        "-o",
        outDir,
      ],
      {
        env: {
          ...process.env,
          CUBIC_API_KEY: "cbk_test_key",
        },
      },
    )

    const events = stdout
      .trim()
      .split("\n")
      .filter((line) => line)
      .map((line) => JSON.parse(line))

    const result = events.find((event) => event.type === "target_result")
    assert.ok(result)
    assert.equal(result.status, "ok")
    assert.equal(result.reason, null)
    assert.equal(result.mcpServers, 1)
  })

  it("does not treat incomplete JSON MCP entries as already installed", async () => {
    const outDir = path.join(TMP_BASE, "skip-incomplete-json-mcp")

    await exec(
      "node",
      [
        CLI,
        "install",
        "--json",
        "--to",
        "cursor",
        "-o",
        outDir,
      ],
      {
        env: {
          ...process.env,
          CUBIC_API_KEY: "cbk_test_key",
        },
      },
    )

    const configPath = path.join(outDir, "cursor", "mcp.json")
    const config = JSON.parse(await readFile(configPath, "utf-8"))
    config.mcpServers.cubic = { enabled: true }
    await writeFile(configPath, JSON.stringify(config, null, 2) + "\n")

    const { stdout } = await exec(
      "node",
      [
        CLI,
        "install",
        "--json",
        "--to",
        "cursor",
        "-o",
        outDir,
      ],
      {
        env: {
          ...process.env,
          CUBIC_API_KEY: "cbk_test_key",
        },
      },
    )

    const events = stdout
      .trim()
      .split("\n")
      .filter((line) => line)
      .map((line) => JSON.parse(line))

    const result = events.find((event) => event.type === "target_result")
    assert.ok(result)
    assert.equal(result.status, "ok")
    assert.equal(result.reason, null)
    assert.equal(result.mcpServers, 1)
  })

  it("recognizes Pi installs as already installed from mcporter baseUrl config", async () => {
    const outDir = path.join(TMP_BASE, "skip-pi-installed")

    await exec(
      "node",
      [
        CLI,
        "install",
        "--json",
        "--to",
        "pi",
        "-o",
        outDir,
      ],
      {
        env: {
          ...process.env,
          CUBIC_API_KEY: "cbk_test_key",
        },
      },
    )

    const { stdout } = await exec("node", [
      CLI,
      "install",
      "--json",
      "--to",
      "pi",
      "-o",
      outDir,
    ])

    const events = stdout
      .trim()
      .split("\n")
      .filter((line) => line)
      .map((line) => JSON.parse(line))

    assert.equal(
      events.some((event) => event.type === "auth_required"),
      false,
      "should not re-prompt for auth when Pi is already configured",
    )

    const result = events.find((event) => event.type === "target_result")
    assert.ok(result)
    assert.equal(result.status, "ok")
    assert.equal(result.reason, "already installed")
  })

  it("keeps per-target manifests separate when Claude and Universal share a home directory", async () => {
    const homeDir = path.join(TMP_BASE, "shared-home")

    await exec(
      "node",
      [
        CLI,
        "install",
        "--json",
        "--to",
        "claude",
      ],
      {
        env: {
          ...process.env,
          HOME: homeDir,
          CUBIC_API_KEY: "cbk_test_key",
        },
      },
    )

    await exec(
      "node",
      [
        CLI,
        "install",
        "--json",
        "--to",
        "universal",
      ],
      {
        env: {
          ...process.env,
          HOME: homeDir,
        },
      },
    )

    await access(path.join(homeDir, ".cubic-manifest.claude.json"))
    await access(path.join(homeDir, ".cubic-manifest.universal.json"))

    const { stdout } = await exec(
      "node",
      [
        CLI,
        "install",
        "--json",
        "--to",
        "claude",
      ],
      {
        env: {
          ...process.env,
          HOME: homeDir,
        },
      },
    )

    const events = stdout
      .trim()
      .split("\n")
      .filter((line) => line)
      .map((line) => JSON.parse(line))

    assert.equal(
      events.some((event) => event.type === "auth_required"),
      false,
      "should still detect Claude as already installed after Universal writes its own manifest",
    )

    const result = events.find((event) => event.type === "target_result")
    assert.ok(result)
    assert.equal(result.status, "ok")
    assert.equal(result.reason, "already installed")
  })

  it("keeps another target's legacy manifest during targeted home cleanup", async () => {
    const homeDir = path.join(TMP_BASE, "shared-home-cleanup-foreign-legacy")
    const legacyManifestPath = path.join(homeDir, ".cubic-manifest.json")

    await mkdir(homeDir, { recursive: true })
    await writeFile(
      legacyManifestPath,
      JSON.stringify({
        manifestVersion: 1,
        pluginVersion: "1.0.0",
        method: "paste",
        installedAt: new Date().toISOString(),
        target: "claude",
        entries: [],
      }, null, 2) + "\n",
    )

    await exec("node", [CLEAN_HOME_SCRIPT, "--to", "universal"], {
      env: {
        ...process.env,
        HOME: homeDir,
      },
    })

    await access(legacyManifestPath)
  })

  it("removes the legacy manifest when it belongs to the selected target", async () => {
    const homeDir = path.join(TMP_BASE, "shared-home-cleanup-matching-legacy")
    const legacyManifestPath = path.join(homeDir, ".cubic-manifest.json")

    await mkdir(homeDir, { recursive: true })
    await writeFile(
      legacyManifestPath,
      JSON.stringify({
        manifestVersion: 1,
        pluginVersion: "1.0.0",
        method: "paste",
        installedAt: new Date().toISOString(),
        target: "universal",
        entries: [],
      }, null, 2) + "\n",
    )

    await exec("node", [CLEAN_HOME_SCRIPT, "--to", "universal"], {
      env: {
        ...process.env,
        HOME: homeDir,
      },
    })

    await assert.rejects(access(legacyManifestPath))
  })

  it("does not delete paths outside managed directories from a tampered manifest", async () => {
    const outDir = path.join(TMP_BASE, "skip-tampered-manifest")

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
          CUBIC_API_KEY: "cbk_test_key",
        },
      },
    )

    const manifestPath = path.join(outDir, "claude", ".cubic-manifest.claude.json")
    const manifest = JSON.parse(await readFile(manifestPath, "utf-8"))
    manifest.pluginVersion = "0.0.0"
    manifest.entries.push({
      name: "../../../escape-target",
      type: "skill",
      file: path.join("skills", "escape-target", "SKILL.md"),
      method: "paste",
    })
    await writeFile(manifestPath, JSON.stringify(manifest, null, 2) + "\n")

    const escapeDir = path.join(outDir, "escape-target")
    await mkdir(escapeDir, { recursive: true })
    await writeFile(path.join(escapeDir, "sentinel.txt"), "do not delete\n")

    const { stdout } = await exec(
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
          CUBIC_API_KEY: "cbk_test_key",
        },
      },
    )

    const events = stdout
      .trim()
      .split("\n")
      .filter((line) => line)
      .map((line) => JSON.parse(line))

    const result = events.find((event) => event.type === "target_result")
    assert.ok(result)
    assert.equal(result.status, "ok")
    assert.equal(result.reason, null)

    await access(path.join(escapeDir, "sentinel.txt"))
  })

  it("does not treat commented Codex sections as installed MCP config", async () => {
    const outDir = path.join(TMP_BASE, "skip-codex-commented-mcp")

    await exec(
      "node",
      [
        CLI,
        "install",
        "--json",
        "--to",
        "codex",
        "-o",
        outDir,
      ],
      {
        env: {
          ...process.env,
          CUBIC_API_KEY: "cbk_test_key",
        },
      },
    )

    const configPath = path.join(outDir, "codex", "config.toml")
    await writeFile(configPath, "# [mcp_servers.cubic]\n")

    const { stdout } = await exec(
      "node",
      [
        CLI,
        "install",
        "--json",
        "--to",
        "codex",
        "-o",
        outDir,
      ],
      {
        env: {
          ...process.env,
          CUBIC_API_KEY: "cbk_test_key",
        },
      },
    )

    const events = stdout
      .trim()
      .split("\n")
      .filter((line) => line)
      .map((line) => JSON.parse(line))

    const result = events.find((event) => event.type === "target_result")
    assert.ok(result)
    assert.equal(result.status, "ok")
    assert.equal(result.reason, null)
    assert.ok(result.prompts > 0)
  })

  it("does not treat bare Codex MCP sections as installed config", async () => {
    const outDir = path.join(TMP_BASE, "skip-codex-bare-mcp")

    await exec(
      "node",
      [
        CLI,
        "install",
        "--json",
        "--to",
        "codex",
        "-o",
        outDir,
      ],
      {
        env: {
          ...process.env,
          CUBIC_API_KEY: "cbk_test_key",
        },
      },
    )

    const configPath = path.join(outDir, "codex", "config.toml")
    await writeFile(configPath, "[mcp_servers.cubic]\n")

    const { stdout } = await exec(
      "node",
      [
        CLI,
        "install",
        "--json",
        "--to",
        "codex",
        "-o",
        outDir,
      ],
      {
        env: {
          ...process.env,
          CUBIC_API_KEY: "cbk_test_key",
        },
      },
    )

    const events = stdout
      .trim()
      .split("\n")
      .filter((line) => line)
      .map((line) => JSON.parse(line))

    const result = events.find((event) => event.type === "target_result")
    assert.ok(result)
    assert.equal(result.status, "ok")
    assert.equal(result.reason, null)
    assert.ok(result.prompts > 0)
  })

  it("does not treat commented Codex auth headers as installed config", async () => {
    const outDir = path.join(TMP_BASE, "skip-codex-commented-auth")

    await exec(
      "node",
      [
        CLI,
        "install",
        "--json",
        "--to",
        "codex",
        "-o",
        outDir,
      ],
      {
        env: {
          ...process.env,
          CUBIC_API_KEY: "cbk_test_key",
        },
      },
    )

    const configPath = path.join(outDir, "codex", "config.toml")
    await writeFile(
      configPath,
      [
        "[mcp_servers.cubic]",
        'url = "https://www.cubic.dev/api/mcp"',
        '# http_headers = { Authorization = "Bearer cbk_test_key" }',
        "",
      ].join("\n"),
    )

    const { stdout } = await exec(
      "node",
      [
        CLI,
        "install",
        "--json",
        "--to",
        "codex",
        "-o",
        outDir,
      ],
      {
        env: {
          ...process.env,
          CUBIC_API_KEY: "cbk_test_key",
        },
      },
    )

    const events = stdout
      .trim()
      .split("\n")
      .filter((line) => line)
      .map((line) => JSON.parse(line))

    const result = events.find((event) => event.type === "target_result")
    assert.ok(result)
    assert.equal(result.status, "ok")
    assert.equal(result.reason, null)
    assert.equal(result.mcpServers, 1)

    const rewrittenConfig = await readFile(configPath, "utf-8")
    assert.match(
      rewrittenConfig,
      /http_headers = \{ Authorization = "Bearer cbk_test_key" \}/,
    )
  })

  it("does not treat stray top-level Codex Authorization keys as installed config", async () => {
    const outDir = path.join(TMP_BASE, "skip-codex-stray-auth")

    await exec(
      "node",
      [
        CLI,
        "install",
        "--json",
        "--to",
        "codex",
        "-o",
        outDir,
      ],
      {
        env: {
          ...process.env,
          CUBIC_API_KEY: "cbk_test_key",
        },
      },
    )

    const configPath = path.join(outDir, "codex", "config.toml")
    await writeFile(
      configPath,
      [
        "[mcp_servers.cubic]",
        'url = "https://www.cubic.dev/api/mcp"',
        'Authorization = "Bearer cbk_test_key"',
        "",
      ].join("\n"),
    )

    const { stdout } = await exec(
      "node",
      [
        CLI,
        "install",
        "--json",
        "--to",
        "codex",
        "-o",
        outDir,
      ],
      {
        env: {
          ...process.env,
          CUBIC_API_KEY: "cbk_test_key",
        },
      },
    )

    const events = stdout
      .trim()
      .split("\n")
      .filter((line) => line)
      .map((line) => JSON.parse(line))

    const result = events.find((event) => event.type === "target_result")
    assert.ok(result)
    assert.equal(result.status, "ok")
    assert.equal(result.reason, null)
    assert.equal(result.mcpServers, 1)

    const rewrittenConfig = await readFile(configPath, "utf-8")
    assert.match(
      rewrittenConfig,
      /http_headers = \{ Authorization = "Bearer cbk_test_key" \}/,
    )
  })

  it("recognizes Codex installs as already installed when the MCP section is valid", async () => {
    const outDir = path.join(TMP_BASE, "skip-codex-installed")

    await exec(
      "node",
      [
        CLI,
        "install",
        "--json",
        "--to",
        "codex",
        "-o",
        outDir,
      ],
      {
        env: {
          ...process.env,
          CUBIC_API_KEY: "cbk_test_key",
        },
      },
    )

    const { stdout } = await exec("node", [
      CLI,
      "install",
      "--json",
      "--to",
      "codex",
      "-o",
      outDir,
    ])

    const events = stdout
      .trim()
      .split("\n")
      .filter((line) => line)
      .map((line) => JSON.parse(line))

    assert.equal(
      events.some((event) => event.type === "auth_required"),
      false,
      "should not re-prompt for auth when Codex is already configured",
    )

    const result = events.find((event) => event.type === "target_result")
    assert.ok(result)
    assert.equal(result.status, "ok")
    assert.equal(result.reason, "already installed")
  })
})
