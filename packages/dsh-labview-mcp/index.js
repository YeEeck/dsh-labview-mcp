/**
 * Host plugin for the dsh-labview-mcp bundle.
 *
 * Scaffold build: the runtime provisioning and MCP registration land in later
 * tickets, so both native diagnostic tools report `state: missing`. They are
 * still registered unconditionally so the user always has a diagnostic surface.
 */

export const inject = ['tools']

const STATES = ['unsupported', 'missing', 'provisioning', 'ready', 'broken', 'conflict']

const STATUS_DESCRIPTION =
  'Read-only diagnostic for the LabVIEW MCP runtime. This is the first place to look when '
  + '`mcp__labview__*` tools are absent or failing: it reports whether the runtime is missing, '
  + 'provisioning, ready, broken, unsupported, or blocked by a conflicting `labview` server.'

const REPAIR_DESCRIPTION =
  'Repair the LabVIEW MCP runtime by re-running provisioning and restarting the MCP server '
  + 'when the runtime is missing or broken. This is the first place to look when '
  + '`mcp__labview__*` tools are absent or failing; it returns the same status report as '
  + '`labview_mcp_status`.'

/**
 * The scaffold status: no platform binary is provisioned yet.
 * @returns {object} the status payload shared by both tools.
 */
function missingStatus() {
  return {
    state: 'missing',
    platform: process.platform,
    arch: process.arch,
  }
}

/**
 * Render a status payload as stable, human-readable `key: value` lines.
 * @param {unknown} _args - unused tool arguments.
 * @param {{state: string, platform: string, arch: string, [key: string]: unknown}} value - status payload.
 * @returns {Array<{type: 'text', text: string}>} one text content block.
 */
function renderStatus(_args, value) {
  const lines = [`state: ${value.state}`, `platform: ${value.platform}`, `arch: ${value.arch}`]
  return [{ type: 'text', text: lines.join('\n') }]
}

const statusOutput = {
  schema: {
    type: 'object',
    additionalProperties: false,
    required: ['state', 'platform', 'arch'],
    properties: {
      state: { type: 'string', enum: STATES },
      platform: { type: 'string' },
      arch: { type: 'string' },
    },
  },
  render: renderStatus,
}

/** Read-only status tool. */
const statusTool = {
  name: 'labview_mcp_status',
  description: STATUS_DESCRIPTION,
  parameters: {},
  output: statusOutput,
  async execute() {
    return missingStatus()
  },
}

/** Repair tool. Accepts `{ force?: boolean }`; the scaffold reports status only. */
const repairTool = {
  name: 'labview_mcp_repair',
  description: REPAIR_DESCRIPTION,
  parameters: {
    force: {
      type: 'boolean',
      description: 'Recopy the runtime even when it looks intact.',
    },
  },
  output: statusOutput,
  async execute() {
    return missingStatus()
  },
}

/**
 * Register the native diagnostic tools for the lifetime of the plugin fiber.
 * @param {object} ctx - Host plugin context carrying the `tools` service and `effect`.
 * @param {object} _config - plugin row config (empty in this scaffold).
 */
export function apply(ctx, _config) {
  ctx.effect(() => ctx.tools.register(statusTool))
  ctx.effect(() => ctx.tools.register(repairTool))
}
