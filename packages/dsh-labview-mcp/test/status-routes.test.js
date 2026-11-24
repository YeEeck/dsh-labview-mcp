import { test } from 'node:test'
import assert from 'node:assert/strict'

import { createStatusRoutes, REPAIR_PATH, STATUS_PATH } from '../status-routes.js'

const READY_STATUS = Object.freeze({
  state: 'ready',
  platform: 'win32',
  arch: 'x64',
  binaryVersion: '3.1.0',
  serverVersion: '3.1.0',
  toolCount: 122,
  toolsDir: 'C:\\tools\\labview-mcp\\3.1.0',
})

/**
 * A service stand-in whose repair settles only when the test says so, so the
 * "answers before the repair finishes" contract can be observed.
 */
function stubService({ status = async () => READY_STATUS } = {}) {
  const repairs = []
  let settle
  const gate = new Promise((resolve, reject) => {
    settle = { resolve, reject }
  })

  return {
    service: {
      status,
      repair(options) {
        repairs.push(options)
        return gate
      },
    },
    repairs,
    done: () => settle.resolve(READY_STATUS),
    fail: (error) => settle.reject(error),
  }
}

/** Build the routes with a fixed clock and an installed binary package. */
function routesFor(service, overrides = {}) {
  return createStatusRoutes({
    service,
    binaryPackageRoot: 'C:\\profile\\node_modules\\dsh-labview-mcp-win32-x64',
    binaryPackageName: 'dsh-labview-mcp-win32-x64',
    binaryPackageRange: '~3.1.0',
    toolsRoot: 'C:\\Users\\PC\\.dsh\\tools\\labview-mcp',
    now: () => 0,
    ...overrides,
  })
}

/** GET the status route and return its decoded body. */
async function readStatus(route) {
  const response = await route.fetch(new Request(`http://host${STATUS_PATH}`))
  return { response, body: await response.json() }
}

/** POST a repair request with an optional raw body. */
async function postRepair(route, body) {
  const init = { method: 'POST' }
  if (body !== undefined) init.body = body
  return route.fetch(new Request(`http://host${REPAIR_PATH}`, init))
}

/** Flush the promise chain a repair settles through. */
function flush() {
  return new Promise((resolve) => setTimeout(resolve, 0))
}

test('the panel owns two plugin-private /api paths with buffered bodies', () => {
  const routes = routesFor(stubService().service)

  assert.deepEqual(routes.map((route) => route.path), [STATUS_PATH, REPAIR_PATH])
  assert.deepEqual(routes.map((route) => route.methods), [['GET'], ['POST']])
  for (const route of routes) {
    assert.equal(route.requestBody, 'buffered')
    assert.match(route.path, /^\/api\/[A-Za-z0-9_$.-]+$/)
  }
})

test('GET reports the runtime status, the binary package, and the tools directory', async () => {
  const { response, body } = await readStatus(routesFor(stubService().service)[0])

  assert.equal(response.status, 200)
  assert.equal(response.headers.get('cache-control'), 'no-store')
  assert.deepEqual(body.status, { ...READY_STATUS })
  assert.deepEqual(body.binaryPackage, {
    installed: true,
    root: 'C:\\profile\\node_modules\\dsh-labview-mcp-win32-x64',
    name: 'dsh-labview-mcp-win32-x64',
    range: '~3.1.0',
  })
  assert.equal(body.toolsRoot, 'C:\\Users\\PC\\.dsh\\tools\\labview-mcp')
  assert.equal(body.repairing, false)
  assert.equal(body.repairError, undefined)
  assert.equal(body.checkedAt, '1970-01-01T00:00:00.000Z')
})

test('a missing binary package reports the required package and range', async () => {
  const { body } = await readStatus(routesFor(stubService().service, { binaryPackageRoot: null })[0])

  assert.deepEqual(body.binaryPackage, {
    installed: false,
    root: null,
    name: 'dsh-labview-mcp-win32-x64',
    range: '~3.1.0',
  })
})

test('a failing status() still answers 200 with a broken state', async () => {
  const service = {
    status: async () => {
      throw new Error('stat failed on the runtime directory')
    },
    repair: async () => READY_STATUS,
  }

  const { response, body } = await readStatus(routesFor(service)[0])

  assert.equal(response.status, 200)
  assert.equal(body.status.state, 'broken')
  assert.match(body.status.lastError, /stat failed on the runtime directory/)
})

test('POST starts one repair and answers while it is still running', async () => {
  const stub = stubService()
  const [statusRoute, repairRoute] = routesFor(stub.service)

  const first = await (await postRepair(repairRoute)).json()
  assert.equal(first.repairing, true)
  assert.deepEqual(stub.repairs, [{ force: false }])

  // A second click, and a malformed body, never start a second pass.
  const second = await (await postRepair(repairRoute, '{not json')).json()
  assert.equal(second.repairing, true)
  assert.equal(stub.repairs.length, 1)

  stub.done()
  await flush()
  assert.equal((await readStatus(statusRoute)).body.repairing, false)
})

test('a settled repair can be started again', async () => {
  const repairs = []
  const service = {
    status: async () => READY_STATUS,
    repair() {
      repairs.push(1)
      return Promise.resolve(READY_STATUS)
    },
  }
  const [, repairRoute] = routesFor(service)

  await postRepair(repairRoute)
  await flush()
  await postRepair(repairRoute)
  await flush()

  assert.equal(repairs.length, 2)
})

test('the repair body may force a re-copy, like the agent tool does', async () => {
  const stub = stubService()
  const [, repairRoute] = routesFor(stub.service)

  await postRepair(repairRoute, JSON.stringify({ force: true }))
  assert.deepEqual(stub.repairs, [{ force: true }])
})

test('a rejected repair is reported without failing the route', async () => {
  const stub = stubService()
  const [statusRoute, repairRoute] = routesFor(stub.service)

  await postRepair(repairRoute)
  stub.fail(new Error('failed to copy the runtime'))
  await flush()

  const { response, body } = await readStatus(statusRoute)
  assert.equal(response.status, 200)
  assert.equal(body.repairing, false)
  assert.match(body.repairError, /failed to copy the runtime/)
})

test('the factory refuses a service that cannot status and repair', () => {
  assert.throws(() => createStatusRoutes({ service: {} }), TypeError)
  assert.throws(() => createStatusRoutes(), TypeError)
})
