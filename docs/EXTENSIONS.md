# 仪表板自有扩展系统（能力协商）

这份文档讲的是**仪表板自己加载的扩展**：它们不注册成 DSH 插件，所以不绑定 DSH 版本、不经过 DSH 的客户端 HMR，也不会出现在 DSH 的插件列表里。

如果你要写的是"注册到仪表板槽位、由 DSH 插件系统加载"的扩展，看 [EXTENSION-API.md](<EXTENSION-API.md>)。两套并存：

| | DSH 槽位扩展（EXTENSION-API） | 自有扩展（本文） |
|---|---|---|
| 谁加载 | DSH 客户端加载器 | 仪表板自己的加载器 |
| 兼容性依据 | DSH 与仪表板包版本 | **能力 id**（`card.facet.v1` 等） |
| 出现在 DSH 插件列表 | 是 | 否（在「仪表板扩展」里） |
| 重载方式 | DSH HMR | 「重新加载扩展」按钮 |
| 形态 | npm 包（`dsh.client`） | 一个目录：`extension.json` + `index.js`（纯 ESM） |

---

## 1. 目录与文件

放在仪表板数据目录下（默认 `~/.dsh/profiles/web/data/session-dashboard/extensions/`）：

```
extensions/
  acme.todo/
    extension.json     # 清单：身份 + 需要的能力
    index.js           # 实现：纯 ES module，export default { facets(host) { … } }
  registry.json        # 只记录"被停用的"，由管理面板写入
```

- **丢进去即启用**；停用状态只存在于 `registry.json` 的 `disabled` 数组里。
- 目录名与清单里的 `id` 必须一致；`id` 只允许字母、数字、`.`、`-`、`_`。
- 路径按 `realpath` 校验，越出扩展目录一律拒绝。
- 清单**由 Host 校验且是权威**：`index.js` 里另导出一个不同的 manifest 拿不到额外能力。

## 2. 清单：声明你需要什么

```json
{
  "id": "acme.todo",
  "name": "待办徽标",
  "version": "0.1.0",
  "description": "在每行显示本轮 todo 完成数",
  "requires": ["card.facet.v1"],
  "optional": ["session.todos.read"]
}
```

- `requires` 是**硬门槛**：任何一项宿主给不了，扩展整体不挂载，管理面板显示「缺少能力」并列出缺失项。
- `optional` 是"有就用"：宿主没有时不报错，但你必须自己探测（`host.todos?.read`）。
- 两个字段里出现未知能力 id → 清单无效（面板会告诉你哪些是已知的）。

## 3. 能力表

| 能力 id | 授予什么 | 不授予时 |
|---|---|---|
| `card.facet.v1` | 往会话行贡献 facet（chip + 浮层） | 扩展没有可挂载的形态 |
| `session.catalog.read` | `host.catalog.session(id)` / `host.catalog.children(id)`：标题、父子、运行态 | `host.catalog` **不存在** |
| `session.todos.read` | `host.todos.read(id)`：该会话本轮的 todo 投影 | `host.todos` **不存在** |
| `session.open.v1` | `host.open(id)`：请原生客户端打开会话 | `host.open` **不存在** |

**关键语义：没声明 = 不存在。** 不是"调用被拒"，而是 `host.todos` 根本是 `undefined`，你一碰就 `TypeError`，面板把它显示成加载失败。这是刻意的：静默返回空数组会让人以为"这条会话没有 todo"，而不是"我忘了声明能力"。

`host` 还有两样永远存在的东西：`host.capabilities`（本次实际授予的集合）和 `host.t`（翻译函数，键名见下表）。

## 4. 实现

```js
/** extension.json 声明 requires: ["card.facet.v1"], optional: ["session.todos.read"] */
export default {
  facets(host) {
    return [{
      id: 'todo',
      // 返回 null = 这条会话不显示这个 facet（0/0 不应出现空胶囊）
      chip(session) {
        const todos = host.todos?.read(session.sessionId)
        if (!todos || todos.length === 0) return null
        const done = todos.filter(item => item.status === 'completed').length
        return { icon: '☑', count: done, total: todos.length, tone: done === todos.length ? 'ok' : 'neutral' }
      },
      // 只在用户点开时调用；可以返回数组，也可以返回 Promise
      rows(session) {
        const todos = host.todos?.read(session.sessionId) ?? []
        return todos.map((item, index) => ({
          id: `t${index}`,
          title: item.content,
          state: item.status === 'completed' ? 'done' : item.status === 'in_progress' ? 'doing' : 'pending',
          meta: host.t(item.status === 'completed' ? 'todoDone' : item.status === 'in_progress' ? 'todoDoing' : 'todoPending'),
        }))
      },
      empty: '本轮没有待办',
    }]
  },
}
```

### facet 契约

| 字段 | 必填 | 说明 |
|---|---|---|
| `id` | ✅ | 扩展内唯一，字母/数字/`._-` |
| `chip(session)` | ✅ | 返回 chip 或 `null`；**渲染时每行都会调用**，请只读快照、别做重活 |
| `rows(session)` | — | 浮层内容，**打开时才调用**；返回 `FacetRow[]` 或 `Promise` |
| `empty` | — | 行数为 0 时显示的文案 |

`session` 的形状：`{ sessionId, title, projectId, activeAgents }`。**拿不到原始 card**，需要别的数据就通过能力去读。

`chip`：`{ icon?, text?, count?, total?, tone?, title? }`，`tone` ∈ `neutral | business | warn | ok | danger`。
`FacetRow`：`{ id, title, meta?, state?, children? }`，`state` ∈ `running | doing | done | pending | failed | idle`；`children` 可以再嵌套（例如"子 Agent → 它自己的 todo"）。

**渲染一律由仪表板负责**：chip 的排版、浮层外壳、视口内翻转、同一时刻只开一个、Portal 挂载、Escape/外点关闭，扩展不参与。这也意味着你的样式不会污染标签页——你根本没有样式。

### 可用的翻译键（`host.t`）

`agentStateRunning`、`agentStateIdle`、`todoDone`、`todoDoing`、`todoPending`、`agentsFacetEmpty`、`todosFacetEmpty`、`facetEmpty`。需要新文案就先用字面量，后续版本再扩键表。

## 5. 状态、错误与重载

「更多操作 → 仪表板扩展…」打开管理面板，每一条会落在以下之一：

| 状态 | 含义 |
|---|---|
| 已挂载 | 导入成功、能力齐全，正在贡献 facet |
| 已停用 | 在 `registry.json` 里被关掉 |
| 不可用 | 清单或 `index.js` 有问题（面板给出原因） |
| 缺少能力 | `requires` 里有宿主给不了的能力（面板列出缺哪几项） |
| 加载失败 | 导入抛错、`facets()` 抛错或返回值不合法 |

停用/启用走 `POST /api/session-dashboard/extensions/enabled`（带会话 cookie，`no-store`）；面板底部的「重新加载扩展」用新的 revision 重新 `import()`，**不需要重启 DSH**。改动 `extension.json` 的能力声明后必须点一次重载。

`disabled` 是一张统一的清单，**内置扩展也在里面**：`builtin.agents`/`builtin.todos` 没有目录，但同样在面板里带「内置」标记和停用按钮，停用后本页不再渲染它们的 facet，重启后仍是停用状态。

一个扩展抛错不会影响别的扩展，也不会让行画不出来：那一行只是少一个 chip。

## 6. 安全边界（请认真读）

扩展代码和仪表板**在同一个页面、同一个权限**下运行：它能碰 `document`、`fetch`、以及 DSH 暴露在页面上的服务。能力声明是**契约与围栏**，不是沙箱——它保证"你没声明的数据不会主动递到你手上"，不保证"你拿不到"。

因此当前模型的前提是：**扩展是你自己（或你审查过的代码）写的**。要跑不可信的第三方扩展，需要 Worker/iframe 隔离，那是后续独立的一层，不在 `v1` 范围内。

## 7. 参考实现

- `examples/hello-extension/`：最小可跑的扩展（一个静态 chip），复制目录即可。它在源码仓库里，不随 npm 包发布。
- 目录列表与模块导入**只随 revision 变**：`importExtensions()` 拿一次清单、导入一次模块，`mountImported()` 负责在 sources 变化时重新挂载。所以看板刷新不会重新读目录、也不会重新 `import()`。
- 内置两个 facet 也已跑在同一套契约上：`src/shared/extensions/agents.ts`（`card.facet.v1` + `optional: session.catalog.read, session.todos.read`）与 `src/shared/extensions/todos.ts`（`optional: session.todos.read`）。它们和外部扩展唯一的区别是"编译进包里"，走的挂载、能力门、错误上报完全一致。
