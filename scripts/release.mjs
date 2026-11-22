#!/usr/bin/env node
/**
 * Maintainer release script for the two `dsh-labview-mcp` npm packages.
 *
 * One run:
 *   1. resolves the latest upstream release from the GitHub API (or a fixture
 *      release JSON passed with `--release-json`),
 *   2. downloads `labview-mcp.zip` through the mirror order GitHub ->
 *      ghfast.top -> gh-proxy.com -> ghproxy.net, verifying every candidate
 *      against the API size and `sha256:` digest; an optional
 *      `labview-mcp.manifest.sha256` asset is verified the same way, otherwise
 *      the builder generates a manifest from the extracted runtime,
 *   3. builds the `dsh-labview-mcp-win32-x64` package (version = upstream tag)
 *      through `buildBinaryPackage()`,
 *   4. packs the `dsh-labview-mcp` plugin package at its own independent
 *      version,
 *   5. runs `npm publish --dry-run` for both package directories, verifies the
 *      published file lists, and writes a full report under `<out>/`.
 *
 * Actual publishing is opt-in with `--publish binary` or `--publish plugin`.
 * Before `--publish plugin` the script checks npm and refuses until the binary
 * package version is 24 hours old; `--skip-publish-cooldown` overrides it.
 * `NPM_TOKEN` is read from the environment only; it is never written into the
 * repository, package metadata, logs, or a command line.
 *
 * Everything is built in a staging directory under `<out>` and only promoted
 * into `<out>` once every download, manifest, structure, and dry-run check has
 * passed. A failure therefore leaves no newly built package tarballs behind.
 *
 * CLI examples:
 *   node scripts/release.mjs
 *   node scripts/release.mjs --release-json release.json --archive .\labview-mcp.zip --manifest .\manifest.sha256 --out dist
 *   node scripts/release.mjs --publish binary
 *
 * Exported API:
 *   runRelease(options)
 *   fetchLatestRelease(options)
 *   parseReleaseMetadata(document)
 *   downloadVerifiedAsset(options)
 */

import { spawn } from 'node:child_process'
import { createHash } from 'node:crypto'
import { createReadStream } from 'node:fs'
import {
  mkdir,
  mkdtemp,
  open,
  readFile,
  rename,
  rm,
  stat,
  writeFile,
} from 'node:fs/promises'
import os from 'node:os'
import path from 'node:path'
import { fileURLToPath } from 'node:url'
import { buildBinaryPackage } from './build-binary-package.mjs'

const SCRIPT_DIRECTORY = path.dirname(fileURLToPath(import.meta.url))
const REPOSITORY_ROOT = path.resolve(SCRIPT_DIRECTORY, '..')

export const DEFAULT_OUT_DIRECTORY = path.join(REPOSITORY_ROOT, 'dist')
export const DEFAULT_API_URL =
  'https://api.github.com/repos/Zuehlke/labview-mcp/releases/latest'
export const ZIP_ASSET_NAME = 'labview-mcp.zip'
export const MANIFEST_ASSET_NAME = 'labview-mcp.manifest.sha256'

/** Mirror order required by the spec. `prefix` is prepended to the GitHub URL. */
export const DEFAULT_MIRRORS = Object.freeze([
  Object.freeze({ id: 'github', prefix: '' }),
  Object.freeze({ id: 'ghfast.top', prefix: 'https://ghfast.top/' }),
  Object.freeze({ id: 'gh-proxy.com', prefix: 'https://gh-proxy.com/' }),
  Object.freeze({ id: 'ghproxy.net', prefix: 'https://ghproxy.net/' }),
])

export const DEFAULT_ZIP_TIMEOUT_MS = 10 * 60 * 1000
export const DEFAULT_MANIFEST_TIMEOUT_MS = 2 * 60 * 1000
export const DEFAULT_API_TIMEOUT_MS = 60 * 1000
export const DEFAULT_REGISTRY_URL = 'https://registry.npmjs.org'
export const BINARY_PACKAGE_NAME = 'dsh-labview-mcp-win32-x64'
export const PLUGIN_PUBLISH_COOLDOWN_MS = 24 * 60 * 60 * 1000

const BINARY_PACKAGE_DIRECTORY_NAME = 'dsh-labview-mcp-win32-x64'
const BINARY_REQUIRED_ENTRIES = Object.freeze([
  'runtime/bin/LabVIEWMCP.exe',
  'VERSION.txt',
  'labview-mcp.manifest.sha256',
  'LICENSE',
  'THIRD-PARTY-NOTICES.md',
])
const BINARY_REQUIRED_PATTERNS = Object.freeze([/^runtime\//])
const PLUGIN_REQUIRED_ENTRIES = Object.freeze([
  'index.js',
  'cordis.patch.yml',
  'icon.svg',
  'README.md',
  'LICENSE',
  'LICENSE-Zuehlke.txt',
  'LICENSE-pylabview.txt',
  'THIRD-PARTY-NOTICES.md',
  'docs/DETAIL.md',
  'docs/DETAIL.zh.md',
  'docs/migration-v1-to-v2.md',
  'docs/preview.svg',
])
const PLUGIN_REQUIRED_PATTERNS = Object.freeze([/^locale\/[^/]+\.json$/])

const SEMVER_PATTERN = /^\d+\.\d+\.\d+(?:-[0-9A-Za-z.-]+)?(?:\+[0-9A-Za-z.-]+)?$/
const TAG_PATTERN = /^v?(\d+\.\d+\.\d+(?:-[0-9A-Za-z.-]+)?(?:\+[0-9A-Za-z.-]+)?)$/
const DIGEST_PATTERN = /^sha256:([0-9a-fA-F]{64})$/

/** Convert an unknown thrown value into a readable message. */
function errorMessage(error) {
  if (error instanceof Error && error.message) return error.message
  return String(error)
}

/** True when the path exists and is a regular file. */
async function isFile(targetPath) {
  try {
    return (await stat(targetPath)).isFile()
  } catch (error) {
    if (error?.code === 'ENOENT' || error?.code === 'ENOTDIR') return false
    throw error
  }
}

/** SHA-256 of a file, streamed. */
function sha256File(filePath) {
  return new Promise((resolve, reject) => {
    const hash = createHash('sha256')
    const stream = createReadStream(filePath)
    stream.on('error', reject)
    stream.on('data', (chunk) => hash.update(chunk))
    stream.on('end', () => resolve(hash.digest('hex')))
  })
}

/** Run a child process and collect stdout/stderr. */
function runProcess(
  command,
  args,
  { cwd, env = process.env, timeoutMs = 10 * 60 * 1000 } = {},
) {
  return new Promise((resolve, reject) => {
    const child = spawn(command, args, {
      cwd,
      env,
      windowsHide: true,
      stdio: ['ignore', 'pipe', 'pipe'],
    })

    let stdout = ''
    let stderr = ''
    let settled = false
    const timer = setTimeout(() => {
      if (settled) return
      settled = true
      child.kill()
      reject(new Error(`${path.basename(command)} timed out after ${timeoutMs} ms`))
    }, timeoutMs)

    child.stdout.on('data', (chunk) => {
      stdout += chunk.toString()
    })
    child.stderr.on('data', (chunk) => {
      stderr += chunk.toString()
    })
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
      if (code === 0) {
        resolve({ stdout, stderr })
        return
      }
      const detail = stderr.trim() || stdout.trim()
      reject(new Error(`${path.basename(command)} exited with code ${code}${detail ? `: ${detail}` : ''}`))
    })
  })
}

/** Path of the platform tar executable (`tar.exe` on Windows). */
function resolveTarExecutable() {
  if (process.platform === 'win32' && process.env.SystemRoot) {
    return path.join(process.env.SystemRoot, 'System32', 'tar.exe')
  }
  return 'tar'
}

/** Build the spawn invocation for npm (`npm.cmd` needs cmd.exe on Windows). */
function npmInvocation(args) {
  if (process.platform === 'win32') {
    return {
      command: process.env.ComSpec ?? 'cmd.exe',
      args: ['/d', '/s', '/c', 'npm', ...args],
    }
  }
  return { command: 'npm', args }
}

/** Run npm and parse its JSON output. */
async function runNpmJson(args, { cwd, env, timeoutMs = 10 * 60 * 1000, label = 'npm' } = {}) {
  const invocation = npmInvocation(args)
  const result = await runProcess(invocation.command, invocation.args, { cwd, env, timeoutMs })
  return parseJsonOutput(result.stdout, label)
}

/** Parse JSON even when npm framed it with non-JSON noise. */
function parseJsonOutput(text, label) {
  const trimmed = String(text ?? '').trim()
  if (!trimmed) throw new Error(`${label} printed no JSON output`)

  try {
    return JSON.parse(trimmed)
  } catch {
    // Fall through to the framed-object/array extraction below.
  }

  const firstObject = trimmed.indexOf('{')
  const firstArray = trimmed.indexOf('[')
  let start = -1
  let end = -1
  if (firstObject !== -1 && (firstArray === -1 || firstObject < firstArray)) {
    start = firstObject
    end = trimmed.lastIndexOf('}')
  } else if (firstArray !== -1) {
    start = firstArray
    end = trimmed.lastIndexOf(']')
  }
  if (start === -1 || end <= start) {
    throw new Error(`${label} printed no JSON output`)
  }
  try {
    return JSON.parse(trimmed.slice(start, end + 1))
  } catch {
    throw new Error(`${label} printed malformed JSON output`)
  }
}

/** Validate and normalise a GitHub release document. */
export function parseReleaseMetadata(document) {
  if (!document || typeof document !== 'object' || Array.isArray(document)) {
    throw new Error('release JSON must be an object')
  }

  const tag = typeof document.tag_name === 'string' ? document.tag_name.trim() : ''
  if (!tag) throw new Error('release JSON has no tag_name')
  const tagMatch = TAG_PATTERN.exec(tag)
  if (!tagMatch) throw new Error(`release tag is not a valid version tag: ${tag}`)
  const version = tagMatch[1]
  if (!SEMVER_PATTERN.test(version)) {
    throw new Error(`release tag is not a valid semantic version: ${tag}`)
  }

  if (!Array.isArray(document.assets)) {
    throw new Error('release JSON has no assets array')
  }

  const parseAsset = (name, asset) => {
    if (!asset) throw new Error(`release JSON has no asset named ${name}`)
    const digest = typeof asset.digest === 'string' ? asset.digest.trim() : ''
    const digestMatch = DIGEST_PATTERN.exec(digest)
    if (!digestMatch) {
      throw new Error(`release asset ${name} has no sha256: digest (got ${JSON.stringify(asset.digest ?? null)})`)
    }
    const size = Number(asset.size)
    if (!Number.isSafeInteger(size) || size <= 0) {
      throw new Error(`release asset ${name} has no valid size`)
    }
    const url = typeof asset.browser_download_url === 'string'
      ? asset.browser_download_url.trim()
      : ''
    const resolvedUrl = url
      || `https://github.com/Zuehlke/labview-mcp/releases/download/${tag}/${name}`
    return {
      name,
      size,
      digest: `sha256:${digestMatch[1].toLowerCase()}`,
      sha256: digestMatch[1].toLowerCase(),
      url: resolvedUrl,
    }
  }

  const findAsset = (name) => document.assets.find((candidate) => candidate?.name === name)
  const zipSource = findAsset(ZIP_ASSET_NAME)
  if (!zipSource) throw new Error(`release JSON has no asset named ${ZIP_ASSET_NAME}`)
  const manifestSource = findAsset(MANIFEST_ASSET_NAME)

  return {
    tag,
    version,
    zipAsset: parseAsset(ZIP_ASSET_NAME, zipSource),
    // The manifest asset is optional: the spec only mandates the zip and its
    // API digest. When absent, the builder generates one from the runtime.
    manifestAsset: manifestSource ? parseAsset(MANIFEST_ASSET_NAME, manifestSource) : null,
  }
}

/** Read a release JSON fixture from disk. */
export async function readReleaseMetadataFile(filePath) {
  const resolvedPath = path.resolve(filePath)
  if (!await isFile(resolvedPath)) {
    throw new Error(`release JSON does not exist: ${resolvedPath}`)
  }
  let text
  try {
    text = await readFile(resolvedPath, 'utf8')
  } catch (error) {
    throw new Error(`could not read release JSON ${resolvedPath}: ${errorMessage(error)}`)
  }
  let document
  try {
    document = JSON.parse(text)
  } catch {
    throw new Error(`release JSON is malformed: ${resolvedPath}`)
  }
  return parseReleaseMetadata(document)
}

/** Fetch and validate the latest release from the GitHub API. */
export async function fetchLatestRelease({
  apiUrl = DEFAULT_API_URL,
  fetchImpl = globalThis.fetch,
  timeoutMs = DEFAULT_API_TIMEOUT_MS,
} = {}) {
  if (typeof fetchImpl !== 'function') {
    throw new Error('global fetch is not available; Node.js 18 or newer is required')
  }
  let response
  try {
    response = await fetchImpl(apiUrl, {
      headers: {
        Accept: 'application/vnd.github+json',
        'User-Agent': 'dsh-labview-mcp-release-script',
      },
      signal: AbortSignal.timeout(timeoutMs),
    })
  } catch (error) {
    throw new Error(`could not read the GitHub release API: ${errorMessage(error)}`)
  }
  if (!response.ok) {
    throw new Error(`GitHub release API returned HTTP ${response.status}`)
  }
  let document
  try {
    document = await response.json()
  } catch {
    throw new Error('GitHub release API returned malformed JSON')
  }
  return parseReleaseMetadata(document)
}

/**
 * Download one release asset, trying every mirror in order.
 * A candidate is accepted only when both the API size and SHA-256 match.
 */
export async function downloadVerifiedAsset({
  asset,
  destinationPath,
  mirrors = DEFAULT_MIRRORS,
  timeoutMs = DEFAULT_ZIP_TIMEOUT_MS,
  fetchImpl = globalThis.fetch,
  label = asset?.name ?? 'release asset',
} = {}) {
  if (!asset?.url) throw new Error(`${label} has no download URL`)
  if (typeof fetchImpl !== 'function') {
    throw new Error('global fetch is not available; Node.js 18 or newer is required')
  }
  const resolvedDestination = path.resolve(destinationPath)
  await mkdir(path.dirname(resolvedDestination), { recursive: true })
  const failures = []

  for (const mirror of mirrors) {
    const url = mirror.prefix ? `${mirror.prefix}${asset.url}` : asset.url
    try {
      const response = await fetchImpl(url, {
        redirect: 'follow',
        headers: { 'User-Agent': 'dsh-labview-mcp-release-script' },
        signal: AbortSignal.timeout(timeoutMs),
      })
      if (!response.ok) throw new Error(`HTTP ${response.status}`)
      if (!response.body) throw new Error('response has no body')

      const hash = createHash('sha256')
      let bytes = 0
      const handle = await open(resolvedDestination, 'w')
      try {
        for await (const chunk of response.body) {
          const buffer = Buffer.from(chunk)
          bytes += buffer.length
          hash.update(buffer)
          let written = 0
          while (written < buffer.length) {
            const { bytesWritten } = await handle.write(buffer, written)
            written += bytesWritten
          }
        }
      } finally {
        await handle.close()
      }

      if (bytes !== asset.size) {
        throw new Error(`size mismatch: expected ${asset.size} bytes, got ${bytes}`)
      }
      const sha256 = hash.digest('hex')
      if (sha256 !== asset.sha256) {
        throw new Error(`SHA-256 mismatch: expected ${asset.sha256}, got ${sha256}`)
      }
      return {
        asset: asset.name,
        source: mirror.id,
        url,
        path: resolvedDestination,
        bytes,
        sha256,
      }
    } catch (error) {
      await rm(resolvedDestination, { force: true }).catch(() => {})
      const timedOut = error?.name === 'TimeoutError' || error?.name === 'AbortError'
      failures.push(`${mirror.id}: ${timedOut ? `timed out after ${timeoutMs} ms` : errorMessage(error)}`)
    }
  }

  throw new Error(
    `could not download ${label} from any mirror:\n  - ${failures.join('\n  - ')}`,
  )
}

/** Verify a local file against the API-provided size and digest. */
async function verifyLocalAsset({ filePath, asset, label }) {
  const resolvedPath = path.resolve(filePath)
  if (!await isFile(resolvedPath)) {
    throw new Error(`${label} does not exist: ${resolvedPath}`)
  }
  const fileStat = await stat(resolvedPath)
  if (fileStat.size !== asset.size) {
    throw new Error(`${label} size mismatch: expected ${asset.size} bytes, got ${fileStat.size}`)
  }
  const sha256 = await sha256File(resolvedPath)
  if (sha256 !== asset.sha256) {
    throw new Error(`${label} SHA-256 mismatch: expected ${asset.sha256}, got ${sha256}`)
  }
  return {
    asset: asset.name,
    source: 'local',
    url: resolvedPath,
    path: resolvedPath,
    bytes: fileStat.size,
    sha256,
  }
}

/** Number of non-empty lines in a checksum manifest. */
async function countManifestEntries(manifestPath) {
  const text = await readFile(manifestPath, 'utf8')
  const lines = text.split(/\r?\n/).filter((line) => line.trim().length > 0)
  if (lines.length === 0) {
    throw new Error(`manifest is empty: ${manifestPath}`)
  }
  return lines.length
}

/** Parse the JSON emitted by `npm pack --json`. */
function parseNpmPackReport(stdout) {
  const parsed = parseJsonOutput(stdout, 'npm pack')
  const report = Array.isArray(parsed) ? parsed[0] : parsed
  if (!report || typeof report !== 'object') {
    throw new Error('npm pack report is empty')
  }
  return report
}

/** Run `npm pack` in a package directory and report the tarball. */
async function packPackage(packageDirectory, packDestination) {
  await mkdir(packDestination, { recursive: true })
  const invocation = npmInvocation([
    'pack',
    '--json',
    '--pack-destination',
    path.resolve(packDestination),
  ])
  const result = await runProcess(invocation.command, invocation.args, {
    cwd: packageDirectory,
  })
  const report = parseNpmPackReport(result.stdout)
  const tarballPath = path.resolve(packDestination, report.filename)
  const tarballStat = await stat(tarballPath)
  return {
    tarballPath,
    tarballBytes: tarballStat.size,
    tarballEntryCount: Array.isArray(report.files) ? report.files.length : null,
    tarballSha256: await sha256File(tarballPath),
  }
}

/** Extract the publish report for one package from npm's JSON output. */
function selectPublishReport(parsed, packageName) {
  let report
  if (Array.isArray(parsed)) {
    report = parsed[0]
  } else if (parsed && typeof parsed === 'object') {
    if (Array.isArray(parsed.files)) report = parsed
    else if (parsed[packageName]) report = parsed[packageName]
    else report = Object.values(parsed)[0]
  }
  if (!report || typeof report !== 'object' || !Array.isArray(report.files)) {
    throw new Error(`npm publish --dry-run reported no file list for ${packageName}`)
  }
  return {
    filename: typeof report.filename === 'string' ? report.filename : null,
    size: Number.isFinite(report.size) ? report.size : null,
    unpackedSize: Number.isFinite(report.unpackedSize) ? report.unpackedSize : null,
    entryCount: Number.isFinite(report.entryCount) ? report.entryCount : report.files.length,
    files: report.files.map((file) => ({
      path: normalizePackagePath(file.path),
      size: file.size,
      mode: file.mode,
    })),
  }
}

/** Run `npm publish --dry-run --json` and return its file list. */
async function runPublishDryRun(packageDirectory, packageName) {
  const parsed = await runNpmJson(['publish', '--dry-run', '--json'], {
    cwd: packageDirectory,
    label: 'npm publish --dry-run',
  })
  return selectPublishReport(parsed, packageName)
}

/** Normalise a tarball or publish-report path to package-relative form. */
function normalizePackagePath(value) {
  return String(value)
    .replaceAll('\\', '/')
    .replace(/^\.\//, '')
    .replace(/^package\//, '')
}

/** List the file entries of a tarball. */
async function listTarballEntries(tarballPath) {
  const result = await runProcess(resolveTarExecutable(), ['-tf', tarballPath], {
    timeoutMs: 5 * 60 * 1000,
  })
  return result.stdout
    .split(/\r?\n/)
    .map((line) => line.trim())
    .filter((line) => line.length > 0)
    .map((line) => normalizePackagePath(line))
    .filter((line) => !line.endsWith('/'))
}

/** Assert a package file list contains every required entry/pattern. */
function assertRequiredEntries(label, filePaths, { files = [], patterns = [] } = {}) {
  const normalized = new Set(filePaths.map((filePath) => normalizePackagePath(filePath)))
  const missing = []
  for (const requiredFile of files) {
    if (!normalized.has(requiredFile)) missing.push(requiredFile)
  }
  for (const pattern of patterns) {
    if (![...normalized].some((filePath) => pattern.test(filePath))) {
      missing.push(String(pattern))
    }
  }
  if (missing.length > 0) {
    throw new Error(`${label} is missing required entries: ${missing.join(', ')}`)
  }
}

/** Require that a tarball and the corresponding publish dry-run agree on content. */
function assertPackageContents({
  label,
  tarballEntries,
  publishFiles,
  requiredFiles,
  requiredPatterns,
}) {
  assertRequiredEntries(`${label} tarball`, tarballEntries, {
    files: requiredFiles,
    patterns: requiredPatterns,
  })
  assertRequiredEntries(`${label} npm publish --dry-run`, publishFiles, {
    files: requiredFiles,
    patterns: requiredPatterns,
  })
}

/** Read name/version of the plugin package; independent of the upstream tag. */
async function readPluginPackage(packageDirectory) {
  const packageJsonPath = path.join(packageDirectory, 'package.json')
  let metadata
  try {
    metadata = JSON.parse(await readFile(packageJsonPath, 'utf8'))
  } catch (error) {
    throw new Error(`could not read plugin package.json at ${packageJsonPath}: ${errorMessage(error)}`)
  }
  if (typeof metadata.name !== 'string' || !metadata.name) {
    throw new Error(`plugin package.json has no name: ${packageJsonPath}`)
  }
  if (typeof metadata.version !== 'string' || !SEMVER_PATTERN.test(metadata.version)) {
    throw new Error(`plugin package.json has no valid version: ${packageJsonPath}`)
  }
  return {
    name: metadata.name,
    version: metadata.version,
    directory: path.resolve(packageDirectory),
    packageJsonPath,
  }
}

/** Replace `destination` with `source` (both files). */
async function moveFile(source, destination) {
  await rm(destination, { force: true })
  await rename(source, destination)
}

/** Remove the token from any text that might be logged. */
function redact(text, secret) {
  if (!secret) return text
  return String(text).split(secret).join('[REDACTED]')
}

/** Actually publish one package; the token only travels through a temp .npmrc env ref. */
async function publishPackage({ packageDirectory, packageName, environment, timeoutMs }) {
  const token = environment?.NPM_TOKEN
  if (typeof token !== 'string' || token.length === 0) {
    throw new Error('NPM_TOKEN is required for publishing; set it in the environment only')
  }
  const npmrcDirectory = await mkdtemp(path.join(os.tmpdir(), 'dsh-labview-mcp-npmrc-'))
  try {
    const npmrcPath = path.join(npmrcDirectory, '.npmrc')
    await writeFile(
      npmrcPath,
      '//registry.npmjs.org/:_authToken=${NPM_TOKEN}\n',
      { mode: 0o600 },
    )
    const invocation = npmInvocation(['publish', '--json', '--userconfig', npmrcPath])
    const result = await runProcess(invocation.command, invocation.args, {
      cwd: packageDirectory,
      env: { ...process.env, ...environment, NPM_TOKEN: token },
      timeoutMs,
    })
    let report = null
    try {
      report = selectPublishReport(parseJsonOutput(result.stdout, 'npm publish'), packageName)
    } catch {
      report = null
    }
    return {
      package: packageName,
      directory: packageDirectory,
      filename: report?.filename ?? null,
      size: report?.size ?? null,
    }
  } catch (error) {
    throw new Error(`npm publish failed for ${packageName}: ${redact(errorMessage(error), token)}`)
  } finally {
    await rm(npmrcDirectory, { recursive: true, force: true }).catch(() => {})
  }
}

/** Report a download without its local, short-lived path. */
function summarizeDownload(download) {
  return {
    asset: download.asset,
    source: download.source,
    url: download.url,
    bytes: download.bytes,
    sha256: download.sha256,
  }
}

/** Small, human-facing projection of a publish dry-run report. */
function summarizePublishReport(report) {
  return {
    filename: report.filename,
    size: report.size,
    unpackedSize: report.unpackedSize,
    entryCount: report.entryCount,
    files: report.files,
  }
}

/**
 * Refuse a plugin publish until the binary package version has been on npm for
 * at least 24 hours (pnpm's default `minimumReleaseAge` is 1440 minutes).
 *
 * Pure apart from the injected `fetchImpl`: tests pass a fixed `now()` and a
 * fake registry response.
 *
 * @param {object} options
 * @param {string} [options.packageName] binary package name.
 * @param {string} options.version binary package version (= upstream version).
 * @param {string} [options.registryUrl] npm registry base URL.
 * @param {number} [options.now] current epoch milliseconds.
 * @param {Function} [options.fetchImpl] fetch implementation.
 * @param {number} [options.minimumAgeMs] required publish age.
 * @returns {Promise<{packageName: string, version: string, publishedAt: string, ageMs: number, minimumAgeMs: number}>}
 */
export async function checkPublishCooldown({
  packageName = BINARY_PACKAGE_NAME,
  version,
  registryUrl = DEFAULT_REGISTRY_URL,
  now = Date.now(),
  fetchImpl = globalThis.fetch,
  minimumAgeMs = PLUGIN_PUBLISH_COOLDOWN_MS,
} = {}) {
  if (typeof version !== 'string' || !version) {
    throw new Error('checkPublishCooldown requires the binary package version')
  }
  if (typeof fetchImpl !== 'function') {
    throw new Error('global fetch is not available; Node.js 18 or newer is required')
  }
  const metadataUrl = `${registryUrl.replace(/\/$/, '')}/${encodeURIComponent(packageName)}`
  let response
  try {
    response = await fetchImpl(metadataUrl, {
      headers: {
        Accept: 'application/json',
        'User-Agent': 'dsh-labview-mcp-release-script',
      },
      signal: AbortSignal.timeout(30_000),
    })
  } catch (error) {
    throw new Error(`could not read npm registry metadata for ${packageName}: ${errorMessage(error)}`)
  }
  if (response.status === 404) {
    throw new Error(
      `refusing to publish the plugin: binary package ${packageName}@${version} is not on npm yet; `
      + 'publish the binary package first and wait 24 hours',
    )
  }
  if (!response.ok) {
    throw new Error(`npm registry returned HTTP ${response.status} for ${packageName}`)
  }
  let metadata
  try {
    metadata = await response.json()
  } catch {
    throw new Error(`npm registry returned malformed JSON for ${packageName}`)
  }
  const publishedAtText = metadata?.time?.[version]
  if (typeof publishedAtText !== 'string') {
    throw new Error(
      `refusing to publish the plugin: npm has no publish time for ${packageName}@${version}; `
      + 'publish the binary package first and wait 24 hours',
    )
  }
  const publishedAt = Date.parse(publishedAtText)
  if (!Number.isFinite(publishedAt)) {
    throw new Error(
      `refusing to publish the plugin: npm publish time for ${packageName}@${version} is invalid: ${publishedAtText}`,
    )
  }
  const ageMs = now - publishedAt
  if (ageMs < 0) {
    throw new Error(
      `refusing to publish the plugin: the publish time of ${packageName}@${version} is in the future`,
    )
  }
  if (ageMs < minimumAgeMs) {
    const remainingMinutes = Math.ceil((minimumAgeMs - ageMs) / 60_000)
    throw new Error(
      `refusing to publish the plugin: ${packageName}@${version} has been on npm for less than `
      + `24 hours (${remainingMinutes} minutes remaining); wait for the cooldown or pass `
      + '--skip-publish-cooldown',
    )
  }
  return {
    packageName,
    version,
    publishedAt: new Date(publishedAt).toISOString(),
    ageMs,
    minimumAgeMs,
  }
}

/**
 * Run one complete release.
 *
 * @param {object} [options]
 * @param {string} [options.releaseJsonPath] offline release metadata fixture.
 * @param {string} [options.archivePath] offline release zip.
 * @param {string} [options.manifestPath] offline manifest asset (requires archivePath).
 * @param {string} [options.outDir] output directory (default `<repo>/dist`).
 * @param {'dry-run'|'binary'|'plugin'} [options.publishMode] `binary`/`plugin` publish for real.
 * @param {boolean} [options.skipPublishCooldown] bypass the plugin publish cooldown.
 * @param {string} [options.registryUrl] npm registry URL used for the cooldown check.
 * @param {number} [options.now] current epoch milliseconds (tests).
 * @param {string} [options.repositoryRoot] repository root used for plugin package resolution.
 * @param {string} [options.pluginPackageDirectory] plugin package directory.
 * @param {string} [options.apiUrl] GitHub API URL.
 * @param {Array} [options.mirrors] mirror descriptors.
 * @param {number} [options.zipTimeoutMs] per-mirror zip timeout.
 * @param {number} [options.manifestTimeoutMs] per-mirror manifest timeout.
 * @param {number} [options.apiTimeoutMs] GitHub API timeout.
 * @param {Function} [options.fetchImpl] fetch implementation (tests).
 * @param {NodeJS.ProcessEnv} [options.environment] environment holding NPM_TOKEN.
 * @returns {Promise<object>} full release report.
 */
export async function runRelease({
  releaseJsonPath,
  archivePath,
  manifestPath,
  outDir = DEFAULT_OUT_DIRECTORY,
  publishMode = 'dry-run',
  skipPublishCooldown = false,
  registryUrl = DEFAULT_REGISTRY_URL,
  now = Date.now(),
  repositoryRoot = REPOSITORY_ROOT,
  pluginPackageDirectory = path.join(repositoryRoot, 'packages', 'dsh-labview-mcp'),
  apiUrl = DEFAULT_API_URL,
  mirrors = DEFAULT_MIRRORS,
  zipTimeoutMs = DEFAULT_ZIP_TIMEOUT_MS,
  manifestTimeoutMs = DEFAULT_MANIFEST_TIMEOUT_MS,
  apiTimeoutMs = DEFAULT_API_TIMEOUT_MS,
  fetchImpl = globalThis.fetch,
  environment = process.env,
} = {}) {
  if (!['dry-run', 'binary', 'plugin'].includes(publishMode)) {
    throw new Error(`publishMode must be "dry-run", "binary" or "plugin": ${publishMode}`)
  }
  if (publishMode !== 'dry-run' && !environment?.NPM_TOKEN) {
    throw new Error(
      `NPM_TOKEN is required for --publish ${publishMode}; set it in the environment only`,
    )
  }
  if (manifestPath && !archivePath) {
    throw new Error('--manifest requires --archive')
  }
  if ((archivePath || manifestPath) && !releaseJsonPath) {
    throw new Error('--archive/--manifest require --release-json so the tag and API digests are known')
  }

  const resolvedOutDir = path.resolve(outDir)
  const release = releaseJsonPath
    ? await readReleaseMetadataFile(releaseJsonPath)
    : await fetchLatestRelease({ apiUrl, fetchImpl, timeoutMs: apiTimeoutMs })

  if (archivePath && !manifestPath && release.manifestAsset) {
    throw new Error(
      '--manifest is required with --archive because the release JSON declares '
      + `${MANIFEST_ASSET_NAME}`,
    )
  }
  if (manifestPath && !release.manifestAsset) {
    throw new Error(
      `--manifest was supplied but the release JSON has no ${MANIFEST_ASSET_NAME} asset `
      + 'to verify it against; omit --manifest and let the builder generate one',
    )
  }

  let publishCooldown = null
  if (publishMode === 'plugin' && !skipPublishCooldown) {
    publishCooldown = await checkPublishCooldown({
      version: release.version,
      registryUrl,
      now,
      fetchImpl,
    })
  }

  const downloadDirectory = await mkdtemp(path.join(os.tmpdir(), 'dsh-labview-mcp-release-'))
  let stagingDirectory = null
  try {
    // ---- 1. Obtain and verify the assets (the manifest is optional) ------
    let manifestDownload = null
    let zipDownload
    let resolvedManifestPath = null
    let resolvedArchivePath

    if (archivePath) {
      resolvedArchivePath = path.resolve(archivePath)
      zipDownload = await verifyLocalAsset({
        filePath: resolvedArchivePath,
        asset: release.zipAsset,
        label: 'release zip',
      })
      if (manifestPath) {
        resolvedManifestPath = path.resolve(manifestPath)
        manifestDownload = await verifyLocalAsset({
          filePath: resolvedManifestPath,
          asset: release.manifestAsset,
          label: 'release manifest',
        })
      }
    } else {
      if (release.manifestAsset) {
        resolvedManifestPath = path.join(downloadDirectory, MANIFEST_ASSET_NAME)
        manifestDownload = await downloadVerifiedAsset({
          asset: release.manifestAsset,
          destinationPath: resolvedManifestPath,
          mirrors,
          timeoutMs: manifestTimeoutMs,
          fetchImpl,
          label: 'release manifest',
        })
      }
      resolvedArchivePath = path.join(downloadDirectory, ZIP_ASSET_NAME)
      zipDownload = await downloadVerifiedAsset({
        asset: release.zipAsset,
        destinationPath: resolvedArchivePath,
        mirrors,
        timeoutMs: zipTimeoutMs,
        fetchImpl,
        label: 'release zip',
      })
    }

    const expectedFileCount = resolvedManifestPath === null
      ? null
      : await countManifestEntries(resolvedManifestPath)

    // ---- 2. Build the binary package and pack the plugin in staging ------
    await mkdir(resolvedOutDir, { recursive: true })
    stagingDirectory = await mkdtemp(path.join(resolvedOutDir, '.release-staging-'))
    const stagedBinaryPackageDirectory = path.join(
      stagingDirectory,
      BINARY_PACKAGE_DIRECTORY_NAME,
    )

    const binaryBuild = await buildBinaryPackage({
      zipPath: resolvedArchivePath,
      version: release.version,
      outDir: stagedBinaryPackageDirectory,
      expectedSha256: release.zipAsset.sha256,
      expectedSize: release.zipAsset.size,
      manifestPath: resolvedManifestPath,
      generateManifest: resolvedManifestPath === null,
      expectedFileCount,
      pack: true,
      packDestination: stagingDirectory,
    })

    const plugin = await readPluginPackage(pluginPackageDirectory)
    const pluginPack = await packPackage(plugin.directory, stagingDirectory)

    // ---- 3. npm publish --dry-run + content assertions -------------------
    const binaryPublishDryRun = await runPublishDryRun(
      stagedBinaryPackageDirectory,
      binaryBuild.packageName,
    )
    const pluginPublishDryRun = await runPublishDryRun(plugin.directory, plugin.name)

    const binaryTarballEntries = await listTarballEntries(binaryBuild.tarballPath)
    const pluginTarballEntries = await listTarballEntries(pluginPack.tarballPath)

    assertPackageContents({
      label: 'binary package',
      tarballEntries: binaryTarballEntries,
      publishFiles: binaryPublishDryRun.files.map((file) => file.path),
      requiredFiles: BINARY_REQUIRED_ENTRIES,
      requiredPatterns: BINARY_REQUIRED_PATTERNS,
    })
    assertPackageContents({
      label: 'plugin package',
      tarballEntries: pluginTarballEntries,
      publishFiles: pluginPublishDryRun.files.map((file) => file.path),
      requiredFiles: PLUGIN_REQUIRED_ENTRIES,
      requiredPatterns: PLUGIN_REQUIRED_PATTERNS,
    })

    // ---- 4. Promote the verified artifacts into the output directory -----
    const finalBinaryPackageDirectory = path.join(
      resolvedOutDir,
      BINARY_PACKAGE_DIRECTORY_NAME,
    )
    const finalBinaryTarball = path.join(
      resolvedOutDir,
      path.basename(binaryBuild.tarballPath),
    )
    const finalPluginTarball = path.join(
      resolvedOutDir,
      path.basename(pluginPack.tarballPath),
    )

    await rm(finalBinaryPackageDirectory, { recursive: true, force: true })
    await rename(stagedBinaryPackageDirectory, finalBinaryPackageDirectory)
    await moveFile(binaryBuild.tarballPath, finalBinaryTarball)
    await moveFile(pluginPack.tarballPath, finalPluginTarball)

    // ---- 5. Optional real publish, then the full report -------------------
    let published = null
    if (publishMode !== 'dry-run') {
      const targetDirectory = publishMode === 'binary'
        ? finalBinaryPackageDirectory
        : plugin.directory
      const targetName = publishMode === 'binary' ? binaryBuild.packageName : plugin.name
      published = await publishPackage({
        packageDirectory: targetDirectory,
        packageName: targetName,
        environment,
        timeoutMs: 10 * 60 * 1000,
      })
    }

    const reportPath = path.join(resolvedOutDir, 'release-report.json')
    const summary = {
      ok: true,
      generatedAt: new Date().toISOString(),
      publishMode,
      release: {
        tag: release.tag,
        version: release.version,
        zipAsset: release.zipAsset,
        manifestAsset: release.manifestAsset,
      },
      downloads: {
        zip: summarizeDownload(zipDownload),
        manifest: manifestDownload ? summarizeDownload(manifestDownload) : null,
      },
      expectedFileCount,
      publishCooldown,
      binary: {
        packageName: binaryBuild.packageName,
        version: binaryBuild.version,
        packageDirectory: finalBinaryPackageDirectory,
        runtimeFileCount: binaryBuild.runtimeFileCount,
        manifestEntryCount: binaryBuild.manifestEntryCount,
        manifestGenerated: binaryBuild.manifestGenerated,
        runtimeBytes: binaryBuild.runtimeBytes,
        tarballPath: finalBinaryTarball,
        tarballBytes: binaryBuild.tarballBytes,
        tarballSha256: binaryBuild.tarballSha256,
        tarballEntryCount: binaryBuild.tarballEntryCount,
        publishDryRun: summarizePublishReport(binaryPublishDryRun),
      },
      plugin: {
        packageName: plugin.name,
        version: plugin.version,
        packageDirectory: plugin.directory,
        tarballPath: finalPluginTarball,
        tarballBytes: pluginPack.tarballBytes,
        tarballSha256: pluginPack.tarballSha256,
        tarballEntryCount: pluginPack.tarballEntryCount,
        publishDryRun: summarizePublishReport(pluginPublishDryRun),
      },
      published,
      reportPath,
    }
    await writeFile(reportPath, `${JSON.stringify(summary, null, 2)}\n`)
    return summary
  } finally {
    if (stagingDirectory) {
      await rm(stagingDirectory, { recursive: true, force: true }).catch(() => {})
    }
    await rm(downloadDirectory, { recursive: true, force: true }).catch(() => {})
  }
}

const CLI_USAGE = `Usage:
  node scripts/release.mjs [options]

Options:
  --release-json <path>        Offline: read release metadata from a JSON fixture
  --archive <zip>             Offline: use this release zip instead of downloading
  --manifest <path>           Offline: use this manifest asset (required with --archive)
  --out <dir>                 Output directory (default: ${DEFAULT_OUT_DIRECTORY})
  --publish <binary|plugin>   Actually publish that package (default: dry-run both)
  --skip-publish-cooldown     Bypass the 24-hour plugin publish cooldown
  --zip-timeout-ms <ms>       Per-mirror zip timeout (default: ${DEFAULT_ZIP_TIMEOUT_MS})
  --manifest-timeout-ms <ms>  Per-mirror manifest timeout (default: ${DEFAULT_MANIFEST_TIMEOUT_MS})
  --api-timeout-ms <ms>       GitHub API timeout (default: ${DEFAULT_API_TIMEOUT_MS})
  --help                      Show this help
`

/** Parse CLI arguments. */
function parseArguments(argv) {
  const options = {}
  const valueFlags = new Map([
    ['--release-json', 'releaseJsonPath'],
    ['--archive', 'archivePath'],
    ['--manifest', 'manifestPath'],
    ['--out', 'outDir'],
    ['--publish', 'publishMode'],
    ['--zip-timeout-ms', 'zipTimeoutMs'],
    ['--manifest-timeout-ms', 'manifestTimeoutMs'],
    ['--api-timeout-ms', 'apiTimeoutMs'],
  ])

  for (let index = 0; index < argv.length; index += 1) {
    const argument = argv[index]
    if (argument === '--help' || argument === '-h') {
      options.help = true
      continue
    }
    if (argument === '--skip-publish-cooldown') {
      options.skipPublishCooldown = true
      continue
    }
    const [flag, inlineValue] = argument.includes('=')
      ? argument.split(/=(.*)/s, 2)
      : [argument, undefined]
    const key = valueFlags.get(flag)
    if (!key) throw new Error(`unknown argument: ${argument}`)
    const value = inlineValue ?? argv[index + 1]
    if (value === undefined || value.startsWith('--')) {
      throw new Error(`missing value for ${flag}`)
    }
    if (inlineValue === undefined) index += 1
    options[key] = value
  }

  if (options.publishMode !== undefined
    && !['binary', 'plugin'].includes(options.publishMode)) {
    throw new Error(`--publish must be "binary" or "plugin": ${options.publishMode}`)
  }
  for (const [flag, key] of [
    ['--zip-timeout-ms', 'zipTimeoutMs'],
    ['--manifest-timeout-ms', 'manifestTimeoutMs'],
    ['--api-timeout-ms', 'apiTimeoutMs'],
  ]) {
    if (options[key] === undefined) continue
    const numeric = Number(options[key])
    if (!Number.isSafeInteger(numeric) || numeric <= 0) {
      throw new Error(`${flag} must be a positive integer: ${options[key]}`)
    }
    options[key] = numeric
  }
  return options
}

/** Compact CLI view: full file lists stay in `<out>/release-report.json`. */
function compactSummary(summary) {
  return {
    ok: summary.ok,
    publishMode: summary.publishMode,
    release: summary.release,
    downloads: summary.downloads,
    expectedFileCount: summary.expectedFileCount,
    publishCooldown: summary.publishCooldown,
    binary: {
      packageName: summary.binary.packageName,
      version: summary.binary.version,
      packageDirectory: summary.binary.packageDirectory,
      runtimeFileCount: summary.binary.runtimeFileCount,
      tarballPath: summary.binary.tarballPath,
      tarballBytes: summary.binary.tarballBytes,
      tarballSha256: summary.binary.tarballSha256,
      publishDryRun: {
        filename: summary.binary.publishDryRun.filename,
        size: summary.binary.publishDryRun.size,
        unpackedSize: summary.binary.publishDryRun.unpackedSize,
        entryCount: summary.binary.publishDryRun.entryCount,
      },
    },
    plugin: {
      packageName: summary.plugin.packageName,
      version: summary.plugin.version,
      packageDirectory: summary.plugin.packageDirectory,
      tarballPath: summary.plugin.tarballPath,
      tarballBytes: summary.plugin.tarballBytes,
      tarballSha256: summary.plugin.tarballSha256,
      publishDryRun: {
        filename: summary.plugin.publishDryRun.filename,
        size: summary.plugin.publishDryRun.size,
        unpackedSize: summary.plugin.publishDryRun.unpackedSize,
        entryCount: summary.plugin.publishDryRun.entryCount,
      },
    },
    published: summary.published,
    reportPath: summary.reportPath,
  }
}

/** CLI entry point. */
async function main(argv) {
  let options
  try {
    options = parseArguments(argv)
  } catch (error) {
    console.error(`release: ${errorMessage(error)}`)
    console.error(CLI_USAGE)
    process.exitCode = 2
    return
  }

  if (options.help) {
    console.log(CLI_USAGE)
    return
  }

  try {
    const summary = await runRelease(options)
    console.log(JSON.stringify(compactSummary(summary), null, 2))
  } catch (error) {
    console.error(`release: ${errorMessage(error)}`)
    process.exitCode = 1
  }
}

const invokedPath = process.argv[1] ? path.resolve(process.argv[1]) : ''
if (invokedPath === fileURLToPath(import.meta.url)) {
  await main(process.argv.slice(2))
}
