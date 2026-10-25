/** Minimal dashboard extension.
 *
 *  Copy this directory into
 *    ~/.dsh/profiles/web/data/session-dashboard/extensions/hello.extension/
 *  then press 更多操作 → 重新加载扩展 (or restart DSH). It declares only
 *  `card.facet.v1`, so its host carries no catalogue, todos or open() — using
 *  one of those would throw immediately instead of silently returning nothing.
 *
 *  See EXTENSIONS.md for the capability table and the facet contract. */
export default {
  facets(host) {
    return [{
      id: 'hello',
      // A chip is data: the dashboard owns layout, colours and the popover shell.
      chip: session => ({ icon: '✦', text: 'hello', tone: 'neutral', title: `来自 hello.extension 的问候 · ${session.title}` }),
      // Read only when the reader opens the panel.
      rows: session => [
        { id: 'session', title: `会话：${session.title}`, meta: session.sessionId.slice(0, 12), state: 'idle' },
        { id: 'capabilities', title: `本扩展被授予的能力：${[...host.capabilities].join(', ')}`, state: 'done' },
      ],
    }]
  },
}
