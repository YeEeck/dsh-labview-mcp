import { test } from 'node:test'
import assert from 'node:assert/strict'
import { readFile, stat } from 'node:fs/promises'
import path from 'node:path'
import { fileURLToPath } from 'node:url'

const packageDir = path.dirname(path.dirname(fileURLToPath(import.meta.url)))
const manifest = JSON.parse(await readFile(path.join(packageDir, 'package.json'), 'utf8'))

/** Read a package-relative UTF-8 file. */
function readPackageFile(relativePath) {
  return readFile(path.join(packageDir, relativePath), 'utf8')
}

/** Assert the SVG has the declared canvas and no active or external content. */
function assertSelfContainedSvg(svg, { width, height, viewBox }) {
  assert.match(svg, new RegExp(`<svg[^>]*\\swidth="${width}"`))
  assert.match(svg, new RegExp(`<svg[^>]*\\sheight="${height}"`))
  assert.match(svg, new RegExp(`<svg[^>]*\\sviewBox="${viewBox}"`))
  for (const banned of ['<script', '<style', '<foreignObject', '<image', '<text', 'href=', 'url(', 'onload=']) {
    assert.ok(!svg.toLowerCase().includes(banned.toLowerCase()), `SVG must not contain ${banned}`)
  }
}

test('public plugin version is 1.0.0 and keeps its optional binary dependency', () => {
  assert.equal(manifest.name, 'dsh-labview-mcp')
  assert.equal(manifest.version, '1.0.0')
  assert.equal(manifest.dependencies, undefined)
  assert.equal(manifest.scripts, undefined)
  assert.deepEqual(manifest.optionalDependencies, {
    'dsh-labview-mcp-win32-x64': '~3.1.0',
  })
  assert.equal(manifest.exports['.'], './index.js')
  assert.equal(manifest.exports['./icon'], './icon.svg')
})

test('package files cover the entry, patch, locales, docs, icon, README, and licenses', () => {
  for (const required of [
    'index.js',
    'cordis.patch.yml',
    'locale/*.json',
    'docs',
    'icon.svg',
    'README.md',
    'LICENSE',
    'LICENSE-Zuehlke.txt',
    'LICENSE-pylabview.txt',
    'THIRD-PARTY-NOTICES.md',
  ]) {
    assert.ok(manifest.files.includes(required), `package.json files is missing ${required}`)
  }
})

test('the bundle ships the browser half behind the runtime status panel', () => {
  assert.equal(manifest.exports['./client'], './client.js')
  assert.equal(manifest.dsh.client.platform, 'web')

  for (const required of ['client.js', 'status-routes.js']) {
    assert.ok(manifest.files.includes(required), `package.json files is missing ${required}`)
  }
})

test('the migration checklist ships in the package and README links it relatively', async () => {
  const readme = await readPackageFile('README.md')
  assert.match(readme, /\]\(docs\/migration-v1-to-v2\.md\)/)
  assert.ok(!readme.includes('../../docs/migration-v1-to-v2.md'))

  const migration = await readPackageFile('docs/migration-v1-to-v2.md')
  assert.match(migration, /^# v1 → v2 迁移与回滚清单/m)
  assert.match(migration, /## 6\. 回滚到 v1/)
  assert.ok(migration.length > 7_000, 'expected the full migration checklist')
})

test('English locale states the unofficial status, cost, requirements, and diagnostics', async () => {
  const locale = JSON.parse(await readPackageFile('locale/en.json'))
  assert.equal(locale.meta.title, 'LabVIEW MCP (unofficial)')
  assert.equal(locale.meta.detail, 'docs/DETAIL.md')

  const description = locale.meta.description
  for (const expected of [
    'unofficial',
    "Zuehlke's LabVIEW MCP",
    'provisions',
    '57 MB',
    '122',
    '65–75k',
    'Windows x64',
    'Plugins',
    'new sessions',
    'mcp__labview__*',
    'labview_mcp_status',
    'labview_mcp_repair',
  ]) {
    assert.ok(description.includes(expected), `English description is missing ${expected}`)
  }
  assert.ok(!description.includes('installs the Windows x64 runtime'))
  assert.equal(description[0], description[0].toUpperCase())
})

test('Chinese locale is complete and points at the Chinese detail document', async () => {
  const locale = JSON.parse(await readPackageFile('locale/zh.json'))
  assert.equal(locale.meta.title, 'LabVIEW MCP (unofficial)')
  assert.equal(locale.meta.detail, 'docs/DETAIL.zh.md')

  const description = locale.meta.description
  for (const expected of [
    '非官方',
    'Zuehlke',
    '供给',
    '57 MB',
    '122',
    '65–75k',
    'Windows x64',
    'Plugins',
    'mcp__labview__*',
    'labview_mcp_status',
    'labview_mcp_repair',
  ]) {
    assert.ok(description.includes(expected), `Chinese description is missing ${expected}`)
  }
})

test('both detail documents are exactly one meaningful preview image line', async () => {
  for (const [relativePath, altPattern] of [
    ['docs/DETAIL.md', /^!\[[^\]]{20,}\]\(preview\.svg\)\n?$/],
    ['docs/DETAIL.zh.md', /^!\[[^\]]{10,}\]\(preview\.svg\)\n?$/],
  ]) {
    const document = await readPackageFile(relativePath)
    assert.equal(document.trimEnd().split(/\r?\n/).length, 1, `${relativePath} must be one line`)
    assert.match(document, altPattern)
  }
})

test('preview is a 640x300 self-contained, text-free SVG', async () => {
  const preview = await readPackageFile('docs/preview.svg')
  assertSelfContainedSvg(preview, { width: 640, height: 300, viewBox: '0 0 640 300' })
  assert.ok((await stat(path.join(packageDir, 'docs/preview.svg'))).size < 1024 * 1024)
})

test('icon is a 36x36 self-contained, text-free SVG with a transparent background', async () => {
  const icon = await readPackageFile('icon.svg')
  assertSelfContainedSvg(icon, { width: 36, height: 36, viewBox: '0 0 36 36' })
  assert.ok(!/<rect[^>]*width="36"[^>]*height="36"/.test(icon), 'icon must not draw a full-canvas tile')
})

test('license and third-party notice files are present', async () => {
  const projectLicense = await readPackageFile('LICENSE')
  assert.match(projectLicense, /^MIT License/)
  assert.match(projectLicense, /dsh-labview-mcp contributors/)

  const upstreamLicense = await readPackageFile('LICENSE-Zuehlke.txt')
  assert.match(upstreamLicense, /^MIT License/)
  assert.match(upstreamLicense, /Zühlke/)

  const pylabviewLicense = await readPackageFile('LICENSE-pylabview.txt')
  assert.match(pylabviewLicense, /^MIT License/)
  assert.match(pylabviewLicense, /Jessica Creighton/)

  const notices = await readPackageFile('THIRD-PARTY-NOTICES.md')
  for (const expected of ['Zuehlke', 'pylabview', 'Python 3.12', 'PSF', 'complete upstream release tree']) {
    assert.ok(notices.includes(expected), `THIRD-PARTY-NOTICES.md is missing ${expected}`)
  }
})
