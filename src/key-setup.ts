import readline from "readline"
import { spawn } from "child_process"
import os from "os"
import type { Emitter } from "./events.js"

const CUBIC_URL =
  "https://www.cubic.dev/settings?tab=integrations&integration=mcp"

function ask(question: string): Promise<string> {
  return new Promise((resolve) => {
    const rl = readline.createInterface({
      input: process.stdin,
      output: process.stdout,
    })
    rl.question(question, (answer) => {
      rl.close()
      resolve(answer.trim())
    })
  })
}

function openBrowser(url: string): void {
  const platform = os.platform()
  let cmd: string
  let args: string[]

  if (platform === "darwin") {
    cmd = "open"
    args = [url]
  } else if (platform === "win32") {
    cmd = "cmd"
    args = ["/c", "start", "", url]
  } else {
    cmd = "xdg-open"
    args = [url]
  }

  try {
    const child = spawn(cmd, args, { detached: true, stdio: "ignore" })
    child.unref()
  } catch {
    // Browser open failed — user can navigate manually
  }
}

function maskKey(key: string): string {
  if (key.length <= 11) return key.slice(0, 7) + "..."
  return key.slice(0, 7) + "..." + key.slice(-4)
}

export async function promptForApiKey(
  emit?: Emitter,
  jsonMode?: boolean,
): Promise<string | undefined> {
  const existing = process.env.CUBIC_API_KEY
  const hasValidEnvKey = Boolean(existing?.startsWith("cbk_"))

  // ── JSON mode: structured events, no text to stdout ─────────
  if (jsonMode && emit) {
    emit({
      type: "auth_required",
      method: "api_key",
      source: hasValidEnvKey ? "env" : "prompt",
      hasEnvKey: hasValidEnvKey,
    })

    if (hasValidEnvKey) {
      emit({ type: "auth_success", source: "env" })
      return existing
    }

    emit({ type: "auth_open_url", url: CUBIC_URL })
    emit({
      type: "auth_warning",
      message:
        "JSON mode is non-interactive. Set CUBIC_API_KEY in the environment before running install.",
    })
    return undefined
  }

  // ── Text mode: original interactive UX ──────────────────────
  if (!process.stdin.isTTY) {
    console.log("\n  No TTY detected. Set your API key manually:")
    console.log("    export CUBIC_API_KEY=cbk_your_key_here")
    console.log(`    Get one at: ${CUBIC_URL}\n`)
    return undefined
  }

  if (existing?.startsWith("cbk_")) {
    const answer = await ask(
      `  API key found in environment (${maskKey(existing)}). Use it? [Y/n] `,
    )
    if (answer.toLowerCase() !== "n") {
      return existing
    }
  }

  console.log("\n  Generate your API key at cubic.dev")
  await ask("  Press Enter to open in browser...")
  openBrowser(CUBIC_URL)

  const raw = await ask("\n  Paste your API key: ")
  const key = raw.replace(/^["']|["']$/g, "")

  if (!key) {
    console.log("  Skipped. You can set CUBIC_API_KEY later.\n")
    return undefined
  }

  if (!key.startsWith("cbk_")) {
    console.log(
      "  Warning: key doesn't start with 'cbk_'. Double-check your key.",
    )
  }

  return key
}
