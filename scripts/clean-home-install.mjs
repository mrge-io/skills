#!/usr/bin/env node

import path from "node:path"
import { promises as fs } from "node:fs"
import { targets, TARGET_NAMES } from "../dist/targets/index.js"
import {
  LEGACY_MANIFEST_FILENAME,
  manifestFilename,
  pathExists,
} from "../dist/utils.js"

const args = process.argv.slice(2)
const dryRun = args.includes("--dry-run")
const toIndex = args.indexOf("--to")
const targetArg = toIndex >= 0 ? args[toIndex + 1] : "all"
const selectedTargets = targetArg === "all" ? TARGET_NAMES : [targetArg]

for (const name of selectedTargets) {
  if (!targets[name]) {
    console.error(
      `Unknown target: ${name}. Available: ${TARGET_NAMES.join(", ")}, all`,
    )
    process.exit(1)
  }
}

async function removeManifest(outputRoot, targetName) {
  const manifestPaths = [path.join(outputRoot, manifestFilename(targetName))]
  const legacyManifestPath = path.join(outputRoot, LEGACY_MANIFEST_FILENAME)
  if (await pathExists(legacyManifestPath)) {
    try {
      const manifest = JSON.parse(await fs.readFile(legacyManifestPath, "utf-8"))
      if (manifest?.target === targetName) {
        manifestPaths.push(legacyManifestPath)
      }
    } catch {
      // Leave malformed legacy manifests alone rather than deleting another target's metadata.
    }
  }
  let removed = false
  for (const manifestPath of manifestPaths) {
    if (!(await pathExists(manifestPath))) continue
    if (!dryRun) await fs.unlink(manifestPath)
    removed = true
  }
  return removed
}

console.log(
  dryRun
    ? "Dry run: checking cubic home installs to remove...\n"
    : "Removing cubic home installs...\n",
)

for (const name of selectedTargets) {
  const outputRoot = targets[name].defaultRoot()
  console.log(`Target: ${name}`)
  console.log(`  Root: ${outputRoot}`)

  if (dryRun) {
    console.log("  Would remove cubic skills/commands/MCP entries")
  } else {
    try {
      await targets[name].uninstall(outputRoot)
    } catch (err) {
      console.error(`  Warning: uninstall failed for ${name}: ${err.message ?? err}`)
      process.exitCode = 1
      continue
    }
  }

  const removedManifest = await removeManifest(outputRoot, name)
  if (dryRun) {
    console.log(`  ${removedManifest ? "Would remove" : "No"} manifest`)
  } else if (removedManifest) {
    console.log("  removed manifest")
  }

  console.log("")
}

console.log(
  dryRun
    ? "Dry run complete. Re-run without --dry-run to remove them."
    : "Done. Restart your editors to apply the cleanup.",
)
