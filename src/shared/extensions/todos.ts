import type { FacetRow } from '../facets.js'
import type { ExtensionModule, HostTodo } from './contract.js'

/** Cap on listed rows: a popover is a glance, not a log viewer. */
const MAX_ROWS = 20

type Translate = (key: string, params?: Record<string, unknown>) => string

/** One todo list as popover rows. Shared by the todos facet and by the nested
 *  plan a running subagent shows under its own row. */
export function todoFacetRows(todos: readonly HostTodo[], t: Translate): FacetRow[] {
  return todos.slice(0, MAX_ROWS).map((todo, index) => ({
    id: `todo:${String(index)}`,
    title: todo.content,
    meta: t(todo.status === 'completed' ? 'todoDone' : todo.status === 'in_progress' ? 'todoDoing' : 'todoPending'),
    state: todo.status === 'completed' ? 'done' : todo.status === 'in_progress' ? 'doing' : 'pending',
  }))
}

/** `☑ 1/3` for this turn's plan, with the three-state list on click.
 *
 *  The todo projection resets on every `turn/start`, so this is the current turn
 *  only. A session without a plan contributes no chip at all — 0/0 must not
 *  render an empty pill. */
export const todosExtension: ExtensionModule = {
  manifest: { id: 'builtin.todos', name: '本轮待办', version: '1', requires: ['card.facet.v1'], optional: ['session.todos.read'] },
  facets(host) {
    return [{
      id: 'todos',
      chip(session) {
        const todos = host.todos?.read(session.sessionId)
        if (todos === null || todos === undefined || todos.length === 0) return null
        const done = todos.filter(todo => todo.status === 'completed').length
        return {
          icon: '☑',
          count: done,
          total: todos.length,
          tone: done === todos.length ? 'ok' : 'neutral',
          title: host.t('todosFacetHint', { done, total: todos.length }),
        }
      },
      rows(session) { return todoFacetRows(host.todos?.read(session.sessionId) ?? [], host.t) },
      empty: host.t('todosFacetEmpty'),
    }]
  },
}
