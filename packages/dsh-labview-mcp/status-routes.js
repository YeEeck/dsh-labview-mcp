/**
 * Exact Fetch routes that carry the LabVIEW MCP runtime status to the bundle's
 * browser half.
 *
 * The Host half answers them through `ctx.connection.fetch`; the browser half
 * fetches them from the bundle's own page in Plugins. They are registered only
 * when the composition provides a browser carrier, so this module stays inert
 * in a headless profile. Keeping the routes free of Cordis makes the whole
 * contract testable without a Host.
 */

/** Read-only status route, answered with a `LabviewStatusView` JSON body. */
export const STATUS_PATH = '/api/labview-mcp.status'

/** Repair route: starts one provisioning pass and answers before it settles. */
export const REPAIR_PATH = '/api/labview-mcp.repair'

const NO_STORE_HEADERS = { 'cache-control': 'no-store' }

/** Convert an unknown thrown value into a readable message. */
function errorMessage(error) {
  if (error instanceof Error && error.message) return error.message
  return String(error)
}

/**
 * Read an optional JSON body. A missing, empty, or malformed body reads as `{}`
 * so a repair request needs no body at all.
 */
async function readJsonBody(request) {
  let text
  try {
    text = await request.text()
  } catch {
    return {}
  }
  if (typeof text !== 'string' || text.trim() === '') return {}

  let parsed
  try {
    parsed = JSON.parse(text)
  } catch {
    return {}
  }
  return parsed !== null && typeof parsed === 'object' && !Array.isArray(parsed) ? parsed : {}
}

/**
 * Build the two exact Fetch routes of the status panel.
 *
 * @param {object} options
 * @param {{ status(): Promise<object>, repair(options?: {force?: boolean}): Promise<object> }} options.service
 *   the `LabviewService` of the running plugin.
 * @param {string|null} [options.binaryPackageRoot] resolved optional binary package root.
 * @param {string|null} [options.toolsRoot] directory holding the versioned runtimes.
 * @param {() => number} [options.now] clock seam for `checkedAt`.
 * @returns {Array<{path: string, methods: string[], requestBody: 'buffered', fetch: (request: Request) => Promise<Response>}>}
 *   route descriptors as `ctx.connection.fetch.register()` takes them.
 */
export function createStatusRoutes({
  service,
  binaryPackageRoot = null,
  toolsRoot = null,
  now = () => Date.now(),
} = {}) {
  if (!service || typeof service.status !== 'function' || typeof service.repair !== 'function') {
    throw new TypeError('createStatusRoutes needs a service with status() and repair()')
  }

  /** In-flight repair, or null. Never awaited by a request. */
  let repair = null
  /** Message of the last repair that rejected, cleared when the next one starts. */
  let repairError

  /** One serializable snapshot of the runtime, safe to render and to poll. */
  async function view() {
    let status
    try {
      status = await service.status()
    } catch (error) {
      status = { state: 'broken', lastError: `status() failed: ${errorMessage(error)}` }
    }

    return {
      status,
      binaryPackage: { installed: binaryPackageRoot !== null, root: binaryPackageRoot },
      toolsRoot,
      repairing: repair !== null,
      ...(repairError === undefined ? {} : { repairError }),
      checkedAt: new Date(now()).toISOString(),
    }
  }

  /** Start one repair; a running repair is never replaced by a second click. */
  function startRepair(force) {
    if (repair !== null) return
    repairError = undefined
    repair = service.repair({ force }).then(
      () => undefined,
      (error) => {
        repairError = errorMessage(error)
      },
    ).finally(() => {
      repair = null
    })
  }

  /** Answer with the current view; a status failure never becomes an HTTP error. */
  async function respond(request) {
    try {
      // A repair request may carry `{ "force": true }` like the agent tool does.
      if (request.method === 'POST') {
        const body = await readJsonBody(request)
        startRepair(body.force === true)
      }
    } catch (error) {
      repairError = errorMessage(error)
    }
    return Response.json(await view(), { headers: NO_STORE_HEADERS })
  }

  return [
    {
      path: STATUS_PATH,
      methods: ['GET'],
      requestBody: 'buffered',
      fetch: respond,
    },
    {
      path: REPAIR_PATH,
      methods: ['POST'],
      requestBody: 'buffered',
      fetch: respond,
    },
  ]
}
