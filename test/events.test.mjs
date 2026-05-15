import { describe, it, beforeEach, afterEach } from "node:test"
import assert from "node:assert/strict"
import { createEmitter } from "../dist/events.js"

describe("createEmitter", () => {
  it("returns no-op function in text mode", () => {
    const emit = createEmitter(false)
    emit({ type: "install_started", mode: "full", target: "all" })
  })

  it("writes NDJSON to stdout in json mode", () => {
    const chunks = []
    const original = process.stdout.write
    process.stdout.write = (chunk) => {
      chunks.push(chunk)
      return true
    }
    try {
      const emit = createEmitter(true)
      emit({ type: "install_started", mode: "full", target: "all" })
      assert.equal(chunks.length, 1)
      assert.ok(chunks[0].endsWith("\n"))
      const parsed = JSON.parse(chunks[0])
      assert.equal(parsed.type, "install_started")
      assert.equal(parsed.version, 1)
      assert.equal(parsed.mode, "full")
      assert.equal(parsed.target, "all")
      assert.ok(parsed.ts)
      assert.ok(parsed.runId)
    } finally {
      process.stdout.write = original
    }
  })

  it("uses consistent runId across events", () => {
    const chunks = []
    const original = process.stdout.write
    process.stdout.write = (chunk) => {
      chunks.push(chunk)
      return true
    }
    try {
      const emit = createEmitter(true)
      emit({ type: "install_started", mode: "full", target: "all" })
      emit({ type: "target_started", agent: "claude" })
      const e1 = JSON.parse(chunks[0])
      const e2 = JSON.parse(chunks[1])
      assert.equal(e1.runId, e2.runId)
    } finally {
      process.stdout.write = original
    }
  })

  it("produces valid ISO timestamps", () => {
    const chunks = []
    const original = process.stdout.write
    process.stdout.write = (chunk) => {
      chunks.push(chunk)
      return true
    }
    try {
      const emit = createEmitter(true)
      emit({ type: "install_started", mode: "full", target: "all" })
      const parsed = JSON.parse(chunks[0])
      assert.ok(!isNaN(new Date(parsed.ts).getTime()))
    } finally {
      process.stdout.write = original
    }
  })
})

describe("event field ordering", () => {
  it("type, version, ts, runId come first", () => {
    const chunks = []
    const original = process.stdout.write
    process.stdout.write = (chunk) => {
      chunks.push(chunk)
      return true
    }
    try {
      const emit = createEmitter(true)
      emit({ type: "install_started", mode: "full", target: "all" })
      const keys = Object.keys(JSON.parse(chunks[0]))
      assert.equal(keys[0], "type")
      assert.equal(keys[1], "version")
      assert.equal(keys[2], "ts")
      assert.equal(keys[3], "runId")
    } finally {
      process.stdout.write = original
    }
  })
})

describe("event types", () => {
  let chunks
  let emit
  let original

  beforeEach(() => {
    chunks = []
    original = process.stdout.write
    process.stdout.write = (chunk) => {
      chunks.push(chunk)
      return true
    }
    emit = createEmitter(true)
  })

  afterEach(() => {
    process.stdout.write = original
  })

  it("install_started (full)", () => {
    emit({ type: "install_started", mode: "full", target: "claude" })
    const e = JSON.parse(chunks[0])
    assert.equal(e.type, "install_started")
    assert.equal(e.mode, "full")
    assert.equal(e.target, "claude")
  })

  it("install_started (skills-only)", () => {
    emit({ type: "install_started", mode: "skills-only", target: "all" })
    const e = JSON.parse(chunks[0])
    assert.equal(e.mode, "skills-only")
  })

  it("target_started", () => {
    emit({ type: "target_started", agent: "opencode" })
    const e = JSON.parse(chunks[0])
    assert.equal(e.type, "target_started")
    assert.equal(e.agent, "opencode")
  })

  it("target_result (ok)", () => {
    emit({
      type: "target_result",
      agent: "claude",
      skills: 4,
      commands: 5,
      prompts: 0,
      mcpServers: 1,
      status: "ok",
      reason: null,
    })
    const e = JSON.parse(chunks[0])
    assert.equal(e.type, "target_result")
    assert.equal(e.agent, "claude")
    assert.equal(e.skills, 4)
    assert.equal(e.commands, 5)
    assert.equal(e.prompts, 0)
    assert.equal(e.mcpServers, 1)
    assert.equal(e.status, "ok")
    assert.equal(e.reason, null)
  })

  it("target_result (failed)", () => {
    emit({
      type: "target_result",
      agent: "codex",
      skills: 0,
      commands: 0,
      prompts: 0,
      mcpServers: 0,
      status: "failed",
      reason: "permission denied",
    })
    const e = JSON.parse(chunks[0])
    assert.equal(e.status, "failed")
    assert.equal(e.reason, "permission denied")
  })

  it("install_summary", () => {
    emit({
      type: "install_summary",
      targetsTotal: 7,
      targetsSucceeded: 7,
      targetsFailed: 0,
      skillsTotal: 28,
      commandsTotal: 25,
      promptsTotal: 10,
      mcpServersTotal: 7,
    })
    const e = JSON.parse(chunks[0])
    assert.equal(e.type, "install_summary")
    assert.equal(e.targetsTotal, 7)
    assert.equal(e.targetsSucceeded, 7)
    assert.equal(e.targetsFailed, 0)
    assert.equal(e.skillsTotal, 28)
    assert.equal(e.commandsTotal, 25)
    assert.equal(e.promptsTotal, 10)
    assert.equal(e.mcpServersTotal, 7)
  })

  it("install_completed", () => {
    emit({ type: "install_completed", ok: true })
    const e = JSON.parse(chunks[0])
    assert.equal(e.type, "install_completed")
    assert.equal(e.ok, true)
  })

  it("install_failed", () => {
    emit({
      type: "install_failed",
      code: "UNKNOWN_TARGET",
      message: "Unknown target",
      retryable: true,
    })
    const e = JSON.parse(chunks[0])
    assert.equal(e.type, "install_failed")
    assert.equal(e.code, "UNKNOWN_TARGET")
    assert.equal(e.message, "Unknown target")
    assert.equal(e.retryable, true)
  })
})
