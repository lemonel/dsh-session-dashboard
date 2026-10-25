import type { FacetRow } from '../facets.js'
import type { ExtensionModule, FacetSpec } from './contract.js'
import { todoFacetRows } from './todos.js'

/** Cap on listed agents: the panel reports live work, not the whole family. */
const MAX_ROWS = 20

/** `⛓ 2` for child agents running under this Session.
 *
 *  The count is a Host fact the row already carries (`activeAgents`), so a
 *  collapsed row costs nothing. Titles come from the Session catalogue and are
 *  read only when the panel opens.
 *
 *  The panel lists the same fact the chip counts — agents running right now —
 *  newest first, plus one muted line for the history it left out: a Session can
 *  own dozens of finished child agents, and a chip that says `1` must not open a
 *  list of all of them.
 *
 *  Nesting each agent's own plan needs `session.todos.read`, which is declared
 *  optional: without it the facet still lists agents, just without their todos. */
export const agentsExtension: ExtensionModule = {
  manifest: {
    id: 'builtin.agents',
    name: '运行中的子 Agent',
    version: '1',
    requires: ['card.facet.v1'],
    optional: ['session.catalog.read', 'session.todos.read'],
  },
  facets(host) {
    const catalog = host.catalog
    const spec: FacetSpec = {
      id: 'agents',
      chip(session) {
        if (session.activeAgents <= 0) return null
        return { icon: '⛓', count: session.activeAgents, tone: 'business', title: host.t('agentsRunningHint') }
      },
      empty: host.t('agentsFacetEmpty'),
    }
    // Without the catalogue there is no list to open: the chip stays a read-only
    // count instead of offering a control that can only fail.
    if (catalog === undefined) return [spec]
    spec.rows = (session) => {
        const children = catalog.children(session.sessionId) ?? []
        const running = children.filter(row => row.running).sort((left, right) => right.updatedAt - left.updatedAt).slice(0, MAX_ROWS)
        const rows: FacetRow[] = running.map(row => {
          // Each subagent is its own Session with its own `todos` projection, so
          // its plan nests here without either facet knowing about the other.
          const todos = host.todos?.read(row.id)
          const nested = todos === undefined || todos === null ? [] : todoFacetRows(todos, host.t)
          return { id: row.id, title: row.title, meta: host.t('agentStateRunning'), state: 'running' as const, ...nested.length > 0 ? { children: nested } : {} }
        })
        const history = children.length - running.length
        if (history > 0) rows.push({ id: 'history', title: host.t('agentsFacetHistory', { count: history }), state: 'idle' })
        return rows
    }
    return [spec]
  },
}
