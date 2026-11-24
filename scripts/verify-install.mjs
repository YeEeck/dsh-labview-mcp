#!/usr/bin/env node
/**
 * Verify that a *fresh* DSH profile can install the plugin together with its
 * runtime package from a registry.
 *
 * The 1.0.0 incident: pnpm skips an optional dependency it cannot resolve and
 * still exits 0, so a mirror without `dsh-labview-mcp-win32-x64@3.1.0` produced
 * a plugin that reported `platform binary package is not installed`. This check
 * creates a throwaway profile, installs the plugin exactly as DSH does, and
 * fails when the runtime package is missing.
 *
 * Usage:
 *   node scripts/verify-install.mjs --version 1.1.0
 *   node scripts/verify-install.mjs --version 1.1.0 --registry https://registry.npmjs.org
 *
 * Run it after publishing the binary package and again after publishing the
 * plugin, for every registry users install from (npmjs and npmmirror).
 */

import { spawn } from 'node:child_process'
import { mkdtemp, readFile, rm, writeFile } from 'node:fs/promises'
import os from 'node:os'
import path from 'node:path'
import { fileURLToPath } from 'node:url'

const REPOSITORY_ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..')
const PLUGIN_PACKAGE = 'dsh-labview-mcp'
const RUNTIME_PACKAGE = 'dsh-labview-mcp-win32-x64'
const DEFAULT_REGISTRIES = ['https://registry.npmjs.org', 'https://registry.npmmirror.com']
const INSTALL_TIMEOUT_MS = 15 * 60 * 1000

/** Convert an unknown thrown value into a readable message. */
function errorMessage(error) {
  if (error instanceof Error && error.message) return error.message
  return String(error)
}

/** Run one child process and capture its combined output. */
function run(command, args, { cwd, timeoutMs = INSTALL_TIMEOUT_MS } = {}) {
  return new Promise((resolve, reject) => {
    const child = spawn(command, args, {
      cwd,
      env: process.env,
      stdio: ['ignore', 'pipe', 'pipe'],
      windowsHide: true,
    })
    let output = ''
    let settled = false
    const timer = setTimeout(() => {
      if (settled) return
      settled = true
      child.kill()
      reject(new Error(`${command} timed out after ${timeoutMs} ms`))
    }, timeoutMs)
    child.stdout.on('data', (chunk) => { output += chunk.toString() })
    child.stderr.on('data', (chunk) => { output += chunk.toString() })
    child.on('error', (error) => {
      if (settled) return
      settled = true
      clearTimeout(timer)
      reject(error)
    })
    child.on('close', (code) => {
      if (settled) return
      settled = true
      clearTimeout(timer)
      resolve({ code: code ?? 1, output })
    })
  })
}

/**
 * pnpm through cmd.exe on Windows, where a .cmd file is not spawnable directly,
 * and through this Node process when the caller points at `pnpm.cjs`/`pnpm.mjs`
 * (the copy DSH bundles has no launcher on PATH).
 */
function pnpmInvocation(command, args) {
  const isScript = /\.(?:c|m)js$/i.test(command)
  if (isScript) return { command: process.execPath, args: [command, ...args] }
  if (process.platform === 'win32') {
    return { command: process.env.ComSpec ?? 'cmd.exe', args: ['/d', '/s', '/c', command, ...args] }
  }
  return { command, args }
}

/** Read a package.json, or null when it is absent. */
async function readManifest(filePath) {
  try {
    return JSON.parse(await readFile(filePath, 'utf8'))
  } catch {
    return null
  }
}

/** Install the plugin into a throwaway profile and check the runtime arrived. */
async function verifyRegistry({ registry, version, pnpm = 'pnpm', keep = false }) {
  const profile = await mkdtemp(path.join(os.tmpdir(), 'dsh-labview-mcp-verify-'))
  const result = { registry, version, profile, ok: false }
  try {
    await writeFile(path.join(profile, 'package.json'), `${JSON.stringify({
      name: 'dsh-profile-labview-verify',
      private: true,
      dsh: { profile: { bundles: [PLUGIN_PACKAGE] } },
    }, null, 2)}\n`)
    await writeFile(path.join(profile, 'pnpm-workspace.yaml'), 'packages:\n  - .\n\nnodeLinker: hoisted\nautoInstallPeers: false\n')

    const invocation = pnpmInvocation(pnpm, [
      'add',
      `${PLUGIN_PACKAGE}@${version}`,
      `--registry=${registry}`,
    ])
    const installed = await run(invocation.command, invocation.args, { cwd: profile })
    result.exitCode = installed.code
    result.output = installed.output.slice(-4000)
    if (installed.code !== 0) {
      result.reason = `pnpm add exited with ${installed.code}`
      return result
    }

    const pluginDir = path.join(profile, 'node_modules', PLUGIN_PACKAGE)
    const runtimeDir = path.join(profile, 'node_modules', RUNTIME_PACKAGE)
    const pluginManifest = await readManifest(path.join(pluginDir, 'package.json'))
    const runtimeManifest = await readManifest(path.join(runtimeDir, 'package.json'))
    result.pluginVersion = pluginManifest?.version ?? null
    result.runtimeVersion = runtimeManifest?.version ?? null
    if (pluginManifest === null) {
      result.reason = `${PLUGIN_PACKAGE} is not in node_modules`
      return result
    }
    if (runtimeManifest === null) {
      result.reason = `${RUNTIME_PACKAGE} is not in node_modules; a fresh profile would report a missing runtime`
      return result
    }
    const declared = pluginManifest.dependencies?.[RUNTIME_PACKAGE]
      ?? pluginManifest.optionalDependencies?.[RUNTIME_PACKAGE]
    if (declared === undefined) {
      result.reason = `${PLUGIN_PACKAGE}@${result.pluginVersion} does not declare ${RUNTIME_PACKAGE}`
      return result
    }
    result.ok = true
    return result
  } catch (error) {
    result.reason = errorMessage(error)
    return result
  } finally {
    if (!keep) await rm(profile, { recursive: true, force: true }).catch(() => {})
  }
}

const USAGE = `Usage:
  node scripts/verify-install.mjs [--version <x.y.z>] [--registry <url>]... [--pnpm <command>] [--keep]

Options:
  --version <x.y.z>   Plugin version to install (default: packages/dsh-labview-mcp/package.json)
  --registry <url>    Registry to verify; repeat for several (default: npmjs, then npmmirror)
  --pnpm <command>    pnpm executable, or a path to pnpm.cjs (default: pnpm)
  --keep              Keep the throwaway profiles for inspection
  --help              Show this help
`

/** Parse CLI arguments. */
function parseArguments(argv) {
  const options = { registries: [] }
  for (let index = 0; index < argv.length; index += 1) {
    const argument = argv[index]
    if (argument === '--help' || argument === '-h') { options.help = true; continue }
    if (argument === '--keep') { options.keep = true; continue }
    const [flag, inlineValue] = argument.includes('=')
      ? argument.split(/=(.*)/s, 2)
      : [argument, undefined]
    if (!['--version', '--registry', '--pnpm'].includes(flag)) {
      throw new Error(`unknown argument: ${argument}`)
    }
    const value = inlineValue ?? argv[index + 1]
    if (value === undefined) throw new Error(`missing value for ${flag}`)
    if (inlineValue === undefined) index += 1
    if (flag === '--registry') options.registries.push(value)
    else if (flag === '--version') options.version = value
    else options.pnpm = value
  }
  return options
}

/** CLI entry point. */
async function main(argv) {
  let options
  try {
    options = parseArguments(argv)
  } catch (error) {
    console.error(`verify-install: ${errorMessage(error)}`)
    console.error(USAGE)
    process.exitCode = 2
    return
  }
  if (options.help) {
    console.log(USAGE)
    return
  }

  let version = options.version
  if (version === undefined) {
    const manifest = await readManifest(path.join(REPOSITORY_ROOT, 'packages', PLUGIN_PACKAGE, 'package.json'))
    version = manifest?.version
  }
  if (typeof version !== 'string' || version.length === 0) {
    console.error('verify-install: no plugin version (pass --version)')
    process.exitCode = 2
    return
  }

  const registries = options.registries.length > 0 ? options.registries : DEFAULT_REGISTRIES
  const results = []
  for (const registry of registries) {
    console.log(`verify-install: ${PLUGIN_PACKAGE}@${version} from ${registry} ...`)
    const result = await verifyRegistry({
      registry,
      version,
      pnpm: options.pnpm ?? 'pnpm',
      keep: options.keep === true,
    })
    results.push(result)
    console.log(result.ok ? '  ok' : `  FAILED: ${result.reason}`)
  }

  const failed = results.filter((result) => !result.ok)
  console.log(JSON.stringify({ ok: failed.length === 0, results }, null, 2))
  if (failed.length > 0) {
    console.error('verify-install: a fresh profile would not get a working runtime from: '
      + failed.map((result) => result.registry).join(', '))
    process.exitCode = 1
  }
}

const invokedPath = process.argv[1] ? path.resolve(process.argv[1]) : ''
if (invokedPath === fileURLToPath(import.meta.url)) {
  await main(process.argv.slice(2))
}
