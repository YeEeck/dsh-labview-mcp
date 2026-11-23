import { test } from 'node:test'
import assert from 'node:assert/strict'
import { readFile, access } from 'node:fs/promises'
import path from 'node:path'
import { fileURLToPath } from 'node:url'
import { apply } from '../index.js'

const packageDir = path.dirname(path.dirname(fileURLToPath(import.meta.url)))
const manifest = JSON.parse(await readFile(path.join(packageDir, 'package.json'), 'utf8'))

/** Minimal stand-in for the Host plugin context, including the injected MCP manager. */
function fakeContext({ connection = false } = {}) {
  const registered = []
  const cleanups = []
  const mcpServers = []
  const routes = []
  const ctx = {
    registered,
    cleanups,
    mcpServers,
    routes,
    tools: {
      register(definition) {
        registered.push(definition)
        return () => {}
      },
    },
    mcpManager: {
      list() {
        return mcpServers
      },
      register(name, _entry) {
        const server = {
          name,
          configured: false,
          status: { state: 'connected', toolCount: 0, connectedAt: Date.now() },
        }
        mcpServers.push(server)
        return () => {
          const index = mcpServers.indexOf(server)
          if (index !== -1) mcpServers.splice(index, 1)
        }
      },
      async probe(name) {
        return {
          ok: true,
          serverInfo: { name, version: '3.1.0' },
          toolNames: [],
          truncated: false,
          durationMs: 1,
        }
      },
    },
    effect(setup) {
      cleanups.push(setup())
    },
    inject(dependencies, callback) {
      if (dependencies.every((dependency) => ctx[dependency] !== undefined)) callback(ctx)
      return () => {}
    },
  }

  if (connection) {
    ctx.connection = {
      fetch: {
        register(route) {
          routes.push(route)
          return () => {}
        },
      },
    }
  }

  return ctx
}

/** Apply the plugin and return its registered tool definitions. */
function registerTools() {
  const ctx = fakeContext()
  apply(ctx, {})
  return ctx.registered
}

/**
 * `apply` starts provisioning in the background. Wait until the service has
 * left the transient `provisioning` state before asserting a settled status.
 */
async function settledStatus(statusTool) {
  for (let attempt = 0; attempt < 200; attempt += 1) {
    const value = await statusTool.execute({}, {})
    if (value.state !== 'provisioning') return value
    await new Promise((resolve) => setTimeout(resolve, 5))
  }
  throw new Error('status did not settle out of provisioning')
}

test('bundle manifest declares a patch and the patch file exists', async () => {
  assert.equal(manifest.dsh?.bundle?.patch, './cordis.patch.yml')
  await access(path.join(packageDir, manifest.dsh.bundle.patch))
})

test('package has no runtime dependencies, install scripts, or build step', () => {
  assert.equal(manifest.dependencies, undefined)
  assert.deepEqual(manifest.optionalDependencies, {
    'dsh-labview-mcp-win32-x64': '~3.1.0',
  })
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

test('the status routes exist only where a browser carrier exists', () => {
  const withCarrier = fakeContext({ connection: true })
  apply(withCarrier, {})
  assert.deepEqual(
    withCarrier.routes.map((route) => route.path),
    ['/api/labview-mcp.status', '/api/labview-mcp.repair'],
  )

  const headless = fakeContext()
  apply(headless, {})
  assert.deepEqual(headless.routes, [])
})

test('status tool reports state: missing', async () => {
  const statusTool = registerTools().find((tool) => tool.name === 'labview_mcp_status')
  const value = await settledStatus(statusTool)

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
