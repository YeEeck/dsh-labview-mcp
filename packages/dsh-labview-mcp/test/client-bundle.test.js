import { test } from 'node:test'
import assert from 'node:assert/strict'
import { readFile } from 'node:fs/promises'
import path from 'node:path'
import vm from 'node:vm'
import { fileURLToPath } from 'node:url'

const packageDir = path.dirname(path.dirname(fileURLToPath(import.meta.url)))
const packageName = 'dsh-labview-mcp'
const source = await readFile(path.join(packageDir, 'client.js'), 'utf8')

const READY_VIEW = {
  status: {
    state: 'ready',
    platform: 'win32',
    arch: 'x64',
    binaryVersion: '3.1.0',
    serverVersion: '3.1.0',
    toolCount: 122,
    toolsDir: 'C:\\Users\\PC\\.dsh\\tools\\labview-mcp\\3.1.0',
  },
  binaryPackage: { installed: true, root: 'C:\\profile\\node_modules\\dsh-labview-mcp-win32-x64' },
  toolsRoot: 'C:\\Users\\PC\\.dsh\\tools\\labview-mcp',
  repairing: false,
  checkedAt: '2026-11-23T00:00:00.000Z',
}

/**
 * Load `client.js` in a sandbox with a fake module loader, React, timers, and
 * fetch, then register both slots against a capturing Cordis-like context.
 */
function loadClient({ fetchImpl } = {}) {
  const definition = {}
  const registrations = []
  const injections = []
  const dictionaries = []
  const requestLog = []
  const cleanups = []
  const intervals = []
  let cleared = 0

  const React = {
    createElement(type, props, ...children) {
      return { type, props: props ?? {}, children }
    },
    useState(initial) {
      return [typeof initial === 'function' ? initial() : initial, () => {}]
    },
    useEffect() {},
  }

  const fakeFetch = fetchImpl ?? (async (url, init) => {
    requestLog.push({ url: String(url), init })
    return { ok: true, status: 200, json: async () => READY_VIEW }
  })

  const sandbox = {
    window: {
      __ModuleLoader__: {
        load(value) {
          Object.assign(definition, value)
        },
      },
    },
    fetch: fakeFetch,
    setInterval(callback, delay) {
      intervals.push(delay)
      return { callback }
    },
    clearInterval() {
      cleared += 1
    },
    console,
  }

  vm.runInNewContext(source, sandbox, { filename: 'client.js' })

  const module = definition.factory((id) => {
    if (id === 'react') return React
    throw new Error(`unexpected require: ${id}`)
  })

  const ctx = {
    effect(callback) {
      const dispose = callback()
      if (typeof dispose === 'function') cleanups.push(dispose)
      return dispose
    },
    locale: {
      register(namespace, dicts) {
        dictionaries.push([namespace, dicts])
        return () => {}
      },
      bind() {
        return (key) => key
      },
    },
    slots: {
      inject(key, callback) {
        injections.push(key)
        callback()
        return () => {}
      },
      register(options, component) {
        registrations.push({ options, component })
        return () => {}
      },
    },
  }

  module.apply(ctx)

  return {
    definition,
    module,
    registrations,
    injections,
    dictionaries,
    requestLog,
    intervals,
    cleared: () => cleared,
    component: (name) => registrations.find((entry) => entry.options.name === name).component,
  }
}

/** Flatten a host-element tree into its visible text, for readable assertions. */
function visibleText(node) {
  if (node === null || node === undefined || node === false || node === true) return ''
  if (typeof node === 'string' || typeof node === 'number') return String(node)
  if (Array.isArray(node)) return node.map(visibleText).join(' ')
  if (typeof node === 'object') {
    const own = node.props && node.props.children !== undefined ? visibleText(node.props.children) : ''
    return [own, ...(node.children ?? []).map(visibleText)].filter(Boolean).join(' ')
  }
  return ''
}

/** Props one slot entry is rendered with: owner subject plus the inject face. */
function propsFor({ snapshot, subject, face }) {
  return {
    subject: subject ?? { kind: 'bundle', pkg: { name: packageName } },
    t: (key) => key,
    useStatus: (selector) => selector(snapshot),
    refresh: face ? face.refresh : () => {},
    repair: face ? face.repair : () => {},
  }
}

test('the browser half registers under the package name with slots and locale', () => {
  const client = loadClient()

  assert.equal(client.definition.id, packageName)
  assert.deepEqual(Array.from(client.module.inject), ['slots', 'locale'])
  assert.deepEqual(Array.from(client.injections), ['plugins.detail.badge', 'plugins.detail.section'])

  assert.equal(client.registrations.length, 2)
  for (const registration of client.registrations) {
    assert.equal(registration.options.id, 'labview-mcp-runtime')
    assert.equal(registration.options.locale, 'labviewMcp')
    assert.equal(typeof registration.options.inject, 'function')
  }

  const [namespace, dicts] = client.dictionaries[0]
  assert.equal(namespace, 'labviewMcp')
  assert.equal(typeof dicts.en.title, 'string')
  assert.equal(typeof dicts.zh.title, 'string')
  assert.equal(dicts.en['state.ready'], 'Ready')
  assert.equal(dicts.zh['state.ready'], '就绪')
})

test('both entries render nothing for a subject they do not own', () => {
  const client = loadClient()
  const badge = client.component('plugins.detail.badge')
  const section = client.component('plugins.detail.section')

  for (const subject of [
    { kind: 'bundle', pkg: { name: 'someone-else' } },
    { kind: 'row', pkg: { name: packageName }, row: { rowId: 'labview-mcp' } },
    { kind: 'item', id: 'shell' },
    undefined,
  ]) {
    const props = { ...propsFor({ snapshot: { phase: 'ready', value: READY_VIEW } }), subject }
    assert.equal(badge(props), null)
    assert.equal(section(props), null)
  }
})

test('the badge stays quiet while loading and names the ready state', () => {
  const client = loadClient()
  const badge = client.component('plugins.detail.badge')

  assert.equal(badge(propsFor({ snapshot: { phase: 'loading' } })), null)
  assert.equal(visibleText(badge(propsFor({ snapshot: { phase: 'ready', value: READY_VIEW } }))), 'state.ready')
  assert.equal(
    visibleText(badge(propsFor({ snapshot: { phase: 'unavailable', reason: 'HTTP 404' } }))),
    'unavailable',
  )
})

test('the section reports every runtime fact, the binary package, and the error', () => {
  const client = loadClient()
  const section = client.component('plugins.detail.section')
  const brokenView = {
    ...READY_VIEW,
    status: { ...READY_VIEW.status, state: 'broken', lastError: 'checksum mismatch for bin/LabVIEWMCP.exe' },
  }

  const text = visibleText(section(propsFor({ snapshot: { phase: 'ready', value: brokenView } })))
  for (const expected of [
    'title',
    'field.state',
    'state.broken',
    'win32 / x64',
    '3.1.0',
    '122',
    'binary.title',
    'binary.installed',
    'C:\\profile\\node_modules\\dsh-labview-mcp-win32-x64',
    'field.toolsDir',
    'error.title',
    'checksum mismatch for bin/LabVIEWMCP.exe',
    'refresh',
    'repair',
    '2026',
  ]) {
    assert.ok(text.includes(expected), `section text is missing ${expected}`)
  }

  const loading = visibleText(section(propsFor({ snapshot: { phase: 'loading' } })))
  assert.ok(loading.includes('loading'))

  const unavailable = visibleText(section(propsFor({ snapshot: { phase: 'unavailable', reason: 'HTTP 401' } })))
  assert.ok(unavailable.includes('unavailableHint'))
  assert.ok(unavailable.includes('HTTP 401'))
})

test('the section disables repair while one runs', () => {
  const client = loadClient()
  const section = client.component('plugins.detail.section')

  const repairing = visibleText(section(propsFor({
    snapshot: { phase: 'ready', value: { ...READY_VIEW, repairing: true } },
  })))
  assert.ok(repairing.includes('repairing'))
})

test('the injected repair posts to the repair route and publishes the answer', async () => {
  const views = []
  const client = loadClient({
    fetchImpl: async (url, init) => {
      views.push({ url: String(url), method: init && init.method })
      return {
        ok: true,
        status: 200,
        json: async () => (String(url).endsWith('.repair') ? { ...READY_VIEW, repairing: true } : READY_VIEW),
      }
    },
  })

  const face = client.registrations[0].options.inject()
  await face.repair()

  assert.deepEqual(views.map((entry) => entry.method), ['POST', undefined])
  assert.ok(views[0].url.endsWith('/api/labview-mcp.repair'))
  assert.ok(views[1].url.endsWith('/api/labview-mcp.status'))
  assert.equal(face.hooks.status.getSnapshot().phase, 'ready')
  assert.equal(face.hooks.status.getSnapshot().value.status.state, 'ready')
})

test('one subscription starts one poll, and dropping it stops the poll', () => {
  const client = loadClient()
  const face = client.registrations[0].options.inject()

  const unsubscribe = face.hooks.status.subscribe(() => {})
  assert.equal(client.intervals.length, 1)
  assert.equal(client.intervals[0], 2000)

  unsubscribe()
  assert.equal(client.cleared(), 1)
})
