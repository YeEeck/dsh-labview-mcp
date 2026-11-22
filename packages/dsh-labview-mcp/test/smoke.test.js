import { test } from 'node:test'
import assert from 'node:assert/strict'
import { readFile, access } from 'node:fs/promises'
import path from 'node:path'
import { fileURLToPath } from 'node:url'
import { apply } from '../index.js'

const packageDir = path.dirname(path.dirname(fileURLToPath(import.meta.url)))
const manifest = JSON.parse(await readFile(path.join(packageDir, 'package.json'), 'utf8'))

/** Minimal stand-in for the Host plugin context. */
function fakeContext() {
  const registered = []
  const cleanups = []
  return {
    registered,
    cleanups,
    tools: {
      register(definition) {
        registered.push(definition)
        return () => {}
      },
    },
    effect(setup) {
      cleanups.push(setup())
    },
  }
}

/** Apply the plugin and return its registered tool definitions. */
function registerTools() {
  const ctx = fakeContext()
  apply(ctx, {})
  return ctx.registered
}

test('bundle manifest declares a patch and the patch file exists', async () => {
  assert.equal(manifest.dsh?.bundle?.patch, './cordis.patch.yml')
  await access(path.join(packageDir, manifest.dsh.bundle.patch))
})

test('package has no runtime dependencies, install scripts, or build step', () => {
  assert.equal(manifest.dependencies, undefined)
  assert.equal(manifest.optionalDependencies, undefined)
  assert.equal(manifest.devDependencies, undefined)
  assert.equal(manifest.scripts, undefined)
})

test('plugin entry exports apply', () => {
  assert.equal(typeof apply, 'function')
})

test('apply registers exactly the two native diagnostic tools', () => {
  const names = registerTools().map((tool) => tool.name)
  assert.deepEqual(names, ['labview_mcp_status', 'labview_mcp_repair'])
})

test('status tool reports state: missing', async () => {
  const statusTool = registerTools().find((tool) => tool.name === 'labview_mcp_status')
  const value = await statusTool.execute({}, {})

  assert.equal(value.state, 'missing')
  assert.equal(value.platform, process.platform)
  assert.equal(value.arch, process.arch)

  const [block] = statusTool.output.render({}, value)
  assert.equal(block.type, 'text')
  assert.ok(block.text.startsWith('state: missing'))
})

test('repair tool accepts an empty argument object and force: true', async () => {
  const repairTool = registerTools().find((tool) => tool.name === 'labview_mcp_repair')

  const withoutForce = await repairTool.execute({}, {})
  const withForce = await repairTool.execute({ force: true }, {})

  assert.equal(withoutForce.state, 'missing')
  assert.equal(withForce.state, 'missing')
})

test('both tool descriptions point to them when the LabVIEW MCP tools are absent or failing', () => {
  for (const tool of registerTools()) {
    assert.match(tool.description, /first place to look/)
    assert.match(tool.description, /mcp__labview__\*/)
  }
})

test('output schemas use the object-level required array the tool registry accepts', () => {
  for (const tool of registerTools()) {
    const schema = tool.output.schema
    assert.equal(schema.type, 'object')
    assert.ok(Array.isArray(schema.required))
    for (const [name, property] of Object.entries(schema.properties)) {
      assert.ok(!('required' in property), `property ${name} must not carry a required flag`)
    }
  }
})
