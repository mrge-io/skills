#!/usr/bin/env node
import { defineCommand, runMain } from "citty"
import install from "./install.js"
import uninstall from "./uninstall.js"

const main = defineCommand({
  meta: {
    name: "cubic-plugin",
    version: "1.0.0",
    description: "Install cubic AI code review plugin for AI coding tools",
  },
  subCommands: {
    install: () => install,
    uninstall: () => uninstall,
  },
})

runMain(main)
