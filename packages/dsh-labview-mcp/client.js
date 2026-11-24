/**
 * Browser half of the dsh-labview-mcp bundle.
 *
 * It shows the runtime state on the bundle's own page in Plugins: a state tag
 * beside the title (`plugins.detail.badge`) and a status card with a Repair
 * action (`plugins.detail.section`). The data comes from the two exact Fetch
 * routes the Host half registers on `ctx.connection.fetch`, so no generated
 * Remote namespace is involved and the bundle keeps its no-build-step layout.
 *
 * Everything here is loaded lazily by the Web module loader; nothing runs until
 * the Plugins page declares the slots this module registers into.
 */

window.__ModuleLoader__.load({
  id: 'dsh-labview-mcp',
  factory(require) {
    const React = require('react')
    const h = React.createElement

    const NAMESPACE = 'labviewMcp'
    const PACKAGE_NAME = 'dsh-labview-mcp'
    const STATUS_URL = '/api/labview-mcp.status'
    const REPAIR_URL = '/api/labview-mcp.repair'
    const POLL_INTERVAL_MS = 2000

    const EN = {
      title: 'Runtime',
      loading: 'Reading the runtime status…',
      unavailable: 'Status unavailable',
      unavailableHint:
        'The plugin page could not reach the LabVIEW MCP runtime endpoint. Restart DSH and open this page '
        + 'again; the native diagnostics still work.',
      'state.ready': 'Ready',
      'state.provisioning': 'Provisioning…',
      'state.missing': 'Not provisioned',
      'state.broken': 'Broken',
      'state.conflict': 'Server conflict',
      'state.unsupported': 'Unsupported platform',
      'state.unknown': 'Unknown',
      'field.state': 'State',
      'field.platform': 'Platform',
      'field.binaryVersion': 'Runtime version',
      'field.serverVersion': 'Server version',
      'field.toolCount': 'Tools',
      'field.toolsDir': 'Runtime directory',
      'binary.title': 'Binary package',
      'binary.installed': 'Installed',
      'binary.missing': 'Not installed — reinstall the plugin (a mirror may lag; use registry.npmjs.org)',
      'binary.root': 'Path',
      'binary.required': 'Required',
      'error.title': 'Last error',
      'repairError.title': 'Repair failed',
      checkedAt: 'Checked',
      refresh: 'Refresh',
      repair: 'Repair',
      repairing: 'Repairing…',
      repairWarning: 'Repair restarts the LabVIEW MCP server; a running tool call may fail.',
      toolHint: 'The agent tools labview_mcp_status and labview_mcp_repair report the same data.',
    }

    const ZH = {
      title: '运行状态',
      loading: '正在读取运行状态…',
      unavailable: '状态不可用',
      unavailableHint: '插件页无法访问 LabVIEW MCP 运行状态接口。请重启 DSH 后重新打开本页；原生诊断工具仍可用。',
      'state.ready': '就绪',
      'state.provisioning': '供给中…',
      'state.missing': '未供给',
      'state.broken': '已损坏',
      'state.conflict': '服务器冲突',
      'state.unsupported': '平台不支持',
      'state.unknown': '未知',
      'field.state': '状态',
      'field.platform': '平台',
      'field.binaryVersion': '运行树版本',
      'field.serverVersion': '服务器版本',
      'field.toolCount': '工具数',
      'field.toolsDir': '运行树目录',
      'binary.title': '二进制包',
      'binary.installed': '已安装',
      'binary.missing': '未安装 — 请重装插件（镜像可能尚未同步，可改用 registry.npmjs.org）',
      'binary.root': '路径',
      'binary.required': '需要',
      'error.title': '最近错误',
      'repairError.title': '修复失败',
      checkedAt: '检查时间',
      refresh: '刷新',
      repair: '修复',
      repairing: '修复中…',
      repairWarning: '修复会重启 LabVIEW MCP 服务器，正在进行的工具调用可能失败。',
      toolHint: '同样的数据也可用 labview_mcp_status / labview_mcp_repair 查看。',
    }

    /** Runtime states that have a localized label; anything else reads as unknown. */
    const STATE_LABEL_KEYS = {
      ready: 'state.ready',
      provisioning: 'state.provisioning',
      missing: 'state.missing',
      broken: 'state.broken',
      conflict: 'state.conflict',
      unsupported: 'state.unsupported',
    }

    /** Colour per state, taken from the theme tokens only. */
    const STATE_TONES = {
      ready: 'var(--dsw-alias-state-success-primary)',
      provisioning: 'var(--dsw-alias-brand-primary)',
      missing: 'var(--dsw-alias-state-warn-primary)',
      broken: 'var(--dsw-alias-state-error-primary)',
      conflict: 'var(--dsw-alias-state-error-primary)',
      unsupported: 'var(--dsw-alias-state-idle-primary)',
      unavailable: 'var(--dsw-alias-state-error-primary)',
      unknown: 'var(--dsw-alias-state-idle-primary)',
    }

    const styles = {
      chip: {
        display: 'inline-flex',
        alignItems: 'center',
        gap: '6px',
        padding: '2px 8px',
        borderRadius: '999px',
        border: '1px solid var(--dsw-alias-border-l1)',
        background: 'var(--dsw-alias-bg-layer-2)',
        color: 'var(--dsw-alias-label-primary)',
        fontSize: '11px',
        fontWeight: 600,
        lineHeight: '18px',
        whiteSpace: 'nowrap',
      },
      dot: {
        width: '6px',
        height: '6px',
        borderRadius: '50%',
        flex: '0 0 auto',
      },
      card: {
        marginTop: '12px',
        padding: '12px 14px',
        border: '1px solid var(--dsw-alias-border-l1)',
        borderRadius: '10px',
        background: 'var(--dsw-alias-bg-layer-1)',
      },
      head: {
        display: 'flex',
        alignItems: 'center',
        justifyContent: 'space-between',
        gap: '12px',
        flexWrap: 'wrap',
      },
      title: {
        margin: 0,
        fontSize: '13px',
        fontWeight: 600,
        color: 'var(--dsw-alias-label-primary)',
      },
      grid: {
        display: 'grid',
        gridTemplateColumns: 'minmax(96px, max-content) 1fr',
        columnGap: '16px',
        rowGap: '6px',
        margin: '10px 0 0',
      },
      fieldLabel: {
        fontSize: '11px',
        color: 'var(--dsw-alias-label-secondary)',
        lineHeight: '18px',
      },
      fieldValue: {
        fontSize: '12px',
        color: 'var(--dsw-alias-label-primary)',
        lineHeight: '18px',
        wordBreak: 'break-word',
      },
      mono: {
        fontFamily: 'ui-monospace, SFMono-Regular, Menlo, Consolas, monospace',
        fontSize: '11px',
      },
      error: {
        marginTop: '10px',
        padding: '8px 10px',
        borderRadius: '8px',
        border: '1px solid var(--dsw-alias-border-l1)',
        background: 'var(--dsw-alias-bg-layer-2)',
        color: 'var(--dsw-alias-state-error-primary)',
        fontSize: '11px',
        lineHeight: '16px',
        whiteSpace: 'pre-wrap',
        wordBreak: 'break-word',
      },
      actions: {
        display: 'flex',
        alignItems: 'center',
        gap: '8px',
        marginTop: '12px',
        flexWrap: 'wrap',
      },
      button: {
        padding: '4px 10px',
        borderRadius: '8px',
        border: '1px solid var(--dsw-alias-border-l2)',
        background: 'var(--dsw-alias-bg-overlay)',
        color: 'var(--dsw-alias-label-primary)',
        fontSize: '12px',
        lineHeight: '18px',
        cursor: 'pointer',
      },
      hint: {
        margin: '8px 0 0',
        fontSize: '11px',
        lineHeight: '16px',
        color: 'var(--dsw-alias-label-secondary)',
      },
      errorTitle: {
        display: 'block',
        marginBottom: '4px',
        fontWeight: 600,
        color: 'var(--dsw-alias-label-secondary)',
      },
    }

    /** The status source shared by both registrations of one client run. */
    function createStatusStore() {
      let snapshot = { phase: 'loading' }
      const listeners = new Set()
      let timer = null
      let inFlight = null

      function publish(next) {
        snapshot = next
        for (const listener of Array.from(listeners)) listener()
      }

      function load() {
        if (inFlight !== null) return inFlight

        const task = (async () => {
          try {
            const response = await fetch(STATUS_URL, {
              headers: { accept: 'application/json' },
              cache: 'no-store',
            })
            if (!response.ok) {
              publish({ phase: 'unavailable', reason: `HTTP ${response.status}` })
              return
            }
            publish({ phase: 'ready', value: await response.json() })
          } catch (error) {
            publish({ phase: 'unavailable', reason: errorText(error) })
          }
        })()

        inFlight = task
        const clear = () => {
          if (inFlight === task) inFlight = null
        }
        task.then(clear, clear)
        return task
      }

      async function repair() {
        try {
          const response = await fetch(REPAIR_URL, {
            method: 'POST',
            headers: { 'content-type': 'application/json', accept: 'application/json' },
            body: '{}',
          })
          if (response.ok) publish({ phase: 'ready', value: await response.json() })
        } catch {
          // A failed request is not a failed repair: the poll reports the outcome.
        }
        await load()
      }

      function subscribe(listener) {
        listeners.add(listener)
        if (listeners.size === 1) {
          void load()
          timer = setInterval(() => {
            void load()
          }, POLL_INTERVAL_MS)
        }
        return () => {
          listeners.delete(listener)
          if (listeners.size === 0 && timer !== null) {
            clearInterval(timer)
            timer = null
          }
        }
      }

      function dispose() {
        listeners.clear()
        if (timer !== null) {
          clearInterval(timer)
          timer = null
        }
      }

      return {
        hooks: { status: { getSnapshot: () => snapshot, subscribe } },
        refresh: () => load(),
        repair,
        dispose,
      }
    }

    /** Readable message for an unknown thrown value. */
    function errorText(error) {
      if (error instanceof Error && error.message) return error.message
      return String(error)
    }

    /** True only for the bundle page of this plugin; every other subject renders nothing. */
    function isOwnBundle(subject) {
      return Boolean(subject)
        && subject.kind === 'bundle'
        && Boolean(subject.pkg)
        && subject.pkg.name === PACKAGE_NAME
    }

    /** The state key to label: the transport phase first, then `status.state`. */
    function stateKeyOf(snapshot) {
      if (snapshot.phase === 'unavailable') return 'unavailable'
      if (snapshot.phase !== 'ready' || !snapshot.value || !snapshot.value.status) return 'unknown'
      const state = snapshot.value.status.state
      return typeof state === 'string' && state !== '' ? state : 'unknown'
    }

    /** Localized label for a state key. */
    function labelOf(key, t) {
      if (key === 'unavailable') return t('unavailable')
      const labelKey = STATE_LABEL_KEYS[key]
      return labelKey === undefined ? t('state.unknown') : t(labelKey)
    }

    /** Theme tone for a state key. */
    function toneOf(key) {
      return STATE_TONES[key] || STATE_TONES.unknown
    }

    /** Tag drawn beside the detail page title. */
    function RuntimeBadge(props) {
      const snapshot = props.useStatus((value) => value)
      if (!isOwnBundle(props.subject) || snapshot.phase === 'loading') return null

      const key = stateKeyOf(snapshot)
      return h(
        'span',
        { style: styles.chip },
        h('span', { style: { ...styles.dot, background: toneOf(key) } }),
        labelOf(key, props.t),
      )
    }

    /** One grid row of the status card. */
    function field(label, value, mono) {
      return { label, value, mono: mono === true }
    }

    /** Status card drawn under the detail page content. */
    function RuntimeSection(props) {
      const snapshot = props.useStatus((value) => value)
      if (!isOwnBundle(props.subject)) return null

      const t = props.t
      const view = snapshot.phase === 'ready' ? snapshot.value : undefined
      const status = view && view.status ? view.status : {}
      const key = stateKeyOf(snapshot)
      const repairing = Boolean(view && view.repairing)

      const head = h(
        'div',
        { style: styles.head },
        h('h3', { style: styles.title }, t('title')),
        h(
          'span',
          { style: styles.chip },
          h('span', { style: { ...styles.dot, background: toneOf(key) } }),
          labelOf(key, t),
        ),
      )

      if (snapshot.phase === 'unavailable') {
        return h(
          'section',
          { style: styles.card },
          head,
          h('p', { style: styles.hint }, t('unavailableHint')),
          snapshot.reason ? h('div', { style: styles.error }, snapshot.reason) : null,
          actions(true),
        )
      }

      if (snapshot.phase !== 'ready' || view === undefined) {
        return h('section', { style: styles.card }, head, h('p', { style: styles.hint }, t('loading')))
      }

      return h(
        'section',
        { style: styles.card },
        head,
        fields(view, status, t),
        status.lastError
          ? errorBlock(t('error.title'), status.lastError)
          : null,
        view.repairError
          ? errorBlock(t('repairError.title'), view.repairError)
          : null,
        h('p', { style: styles.hint }, `${t('checkedAt')}: ${checkedAtLabel(view.checkedAt)}`),
        actions(repairing || key === 'unsupported'),
        h('p', { style: styles.hint }, t('repairWarning')),
        h('p', { style: styles.hint }, t('toolHint')),
      )

      /** Every fact the card reports, in display order. */
      function fields(currentView, currentStatus, translate) {
        const rows = [
          field(translate('field.state'), labelOf(key, translate)),
        ]

        if (currentStatus.platform || currentStatus.arch) {
          rows.push(field(
            translate('field.platform'),
            [currentStatus.platform, currentStatus.arch].filter(Boolean).join(' / '),
          ))
        }
        if (currentStatus.binaryVersion) {
          rows.push(field(translate('field.binaryVersion'), currentStatus.binaryVersion))
        }
        if (currentStatus.serverVersion) {
          rows.push(field(translate('field.serverVersion'), currentStatus.serverVersion))
        }
        if (typeof currentStatus.toolCount === 'number') {
          rows.push(field(translate('field.toolCount'), String(currentStatus.toolCount)))
        }

        const binary = currentView.binaryPackage
        rows.push(field(
          translate('binary.title'),
          binary && binary.installed ? translate('binary.installed') : translate('binary.missing'),
        ))
        if (binary && binary.root) {
          rows.push(field(translate('binary.root'), binary.root, true))
        }
        if (binary && !binary.installed && binary.name) {
          rows.push(field(
            translate('binary.required'),
            binary.range ? `${binary.name}@${binary.range}` : binary.name,
            true,
          ))
        }

        const toolsDir = currentStatus.toolsDir || currentView.toolsRoot
        if (toolsDir) rows.push(field(translate('field.toolsDir'), toolsDir, true))

        return h(
          'div',
          { style: styles.grid },
          rows.flatMap((row, index) => [
            h('span', { key: `label-${index}`, style: styles.fieldLabel }, row.label),
            h(
              'span',
              { key: `value-${index}`, style: row.mono ? { ...styles.fieldValue, ...styles.mono } : styles.fieldValue },
              row.value,
            ),
          ]),
        )
      }

      /** A titled error body, wrapping long Host diagnostics. */
      function errorBlock(title, text) {
        return h(
          'div',
          { style: styles.error },
          h('span', { style: styles.errorTitle }, title),
          text,
        )
      }

      /** Refresh and Repair; Repair is disabled while one runs or on a foreign platform. */
      function actions(repairDisabled) {
        return h(
          'div',
          { style: styles.actions },
          h(
            'button',
            {
              type: 'button',
              style: styles.button,
              onClick: () => {
                void props.refresh()
              },
            },
            t('refresh'),
          ),
          h(
            'button',
            {
              type: 'button',
              style: styles.button,
              disabled: Boolean(repairDisabled),
              onClick: () => {
                void props.repair()
              },
            },
            repairing ? t('repairing') : t('repair'),
          ),
        )
      }
    }

    /** Render an ISO timestamp in the browser's own locale, tolerating garbage. */
    function checkedAtLabel(value) {
      if (typeof value !== 'string') return '—'
      const parsed = new Date(value)
      if (Number.isNaN(parsed.getTime())) return '—'
      return parsed.toLocaleString()
    }

    /** Register the status tag and card for the lifetime of this client half. */
    function apply(ctx) {
      const store = createStatusStore()

      ctx.effect(() => ctx.locale.register(NAMESPACE, { en: EN, zh: ZH }))
      ctx.effect(() => () => store.dispose())

      const injectFace = () => ({
        hooks: { status: store.hooks.status },
        refresh: () => store.refresh(),
        repair: () => store.repair(),
      })

      const registration = (name) => ({
        name,
        id: 'labview-mcp-runtime',
        order: 0,
        locale: NAMESPACE,
        inject: injectFace,
      })

      ctx.slots.inject('plugins.detail.badge', () => ctx.slots.register(
        registration('plugins.detail.badge'),
        RuntimeBadge,
      ))
      ctx.slots.inject('plugins.detail.section', () => ctx.slots.register(
        registration('plugins.detail.section'),
        RuntimeSection,
      ))
    }

    return { inject: ['slots', 'locale'], apply }
  },
})
