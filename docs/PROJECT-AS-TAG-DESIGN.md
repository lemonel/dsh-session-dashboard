# 项目即标签（Project as a Tag）设计稿

状态：**已实现（schema v11）**：持久化 tag-only + 运行时投影、迁移、标签管理器里的项目组、会话详情的按组单选均已落地；v11 再补上标签组的自定义顺序与折叠式管理器、把右上角状态汇总泛化为可按组/按标签筛选的 selector。
本文回答两个前置问题，并给出把「项目」并入标签系统的完整设计、迁移与回滚边界。

## 0. 结论先行

- 推荐：把项目变成**内置标签组** `__project__` 的一个值；卡片用它表达"属于哪个项目"。
- **所有标签组一律单值**：一个会话在同一个组里最多一个值（含项目组，也含自定义组）。没有"多值组"这种形态。
- 一个会话**仍然只能属于一个项目**，因为项目卡片、拖放、未归属、归档都依赖"唯一归属"；现在这条约束来自统一的标签规则，而不是项目专属字段。
- 项目上的**公共标签**保留，改为挂在项目标签值上的 `carriedTagIds`。
- 迁移单向（v9 → v10）；旧版（≤0.7.0）打不开 v10 库，回滚只能恢复备份。
- 为不打断兄弟插件（`session-dashboard-automation`、`baseline-scheduler`），`board.projects` 与 `card.projectId` 继续以**只读投影**出现在快照里，但不再是持久化字段。

## 1. 现状：两个维度

| | 项目 project | 标签 tag |
|---|---|---|
| 持久化 | `board.projects: {id,name,color,tagIds,revision}[]` | `board.tags: {id,name,color,groupId,revision}[]` |
| 组 | 无（项目本身就是一层） | `board.tagGroups: {id,name,...}[]` |
| 卡片关系 | `card.projectId: id \| null`（**至多一个**） | `card.tagIds: id[]`（多个，无组内上限） |
| 顺序 | `board.orders.project` | `board.orders.tag` |
| 命令 | `create_project` / `update_project` / `delete_project` | `create_label` / `update_label` / `delete_label` |
| 空值语义 | 未归属 | 无标签 |
| 专属 UI | 项目卡、新建会话、拖入项目、公共标签、删除项目 | 标签管理器（组 + 值） |

关键事实：

- **当前没有任何"组内单值"约束**：同一个会话可以在同一个标签组里选多个值（`invariants` 只校验 id 唯一、组存在、名称唯一）。"项目只有一个"不是因为标签规则，而是因为项目是另一张表、另一个字段。
- 因此"项目变成标签"要新增的是一条**组级基数规则**，而不是复用现有规则。

## 2. 两个前置问题

### 2.1 「tag 本身不支持一个会话绑定一类 tag 的多个值吧？」

现状：**支持，而且没有组内上限**。组只是命名空间，`card.tagIds` 是扁平数组，`invariants` 只校验 id 唯一、组存在、名称唯一；"项目只有一个"来自 `card.projectId` 这个独立字段，不是标签规则。

本方案的决定（按你的口径）：**所有组一律单值**。

```ts
// 不再需要 mode 字段：单值是全局规则
card.tagIds 中，同一 groupId 至多出现一次
```

- 写入端：`create_label` 值归属哪个组由标签决定；`edit_card`/`set_card_tags` 若同一组给了两个值 → `INVALID`。
- 持久化端：`invariants` 在加载时同样拒绝（脏库不会被静默修复）。
- 未分组标签（`groupId: null`）视为**一个隐式组「未分组」**，同样单值——这样规则没有例外，且"未分组"不会变成唯一的法外之地。
- 这条规则让"任意组都可以当维度"成立：单值 ⇒ 每张卡在每个组里恰好落在 0 或 1 个桶，不存在一张卡出现在同一维度的两列。

### 2.2 「这个公共标签是什么？」

**项目公共标签** = `project.tagIds`：挂在项目上的一组标签。项目内的每个会话在**展示与筛选**时都被视为拥有这些标签，但标签不会被复制进 `card.tagIds`：

```ts
projectTags(board, card)   = 项目上的 tagIds
effectiveTags(board, card) = card.tagIds ∪ projectTags(board, card)   // 去重
tagSources(board, card, id) = { own: card.tagIds.includes(id), project: projectTags(...).includes(id) }
```

它出现在这些地方：

| 位置 | 用法 |
|---|---|
| 项目卡展开区底部 | 显示项目前 2 个公共标签 |
| 会话行 / 抽屉的标签区 | 显示生效标签，并标注来源（项目 / 会话 / 两者都有） |
| 筛选 | `tagSource: effective \| own \| project` 决定用哪一套 |
| 标签条件筛选（TagFilter） | 默认按生效标签匹配 |
| 项目编辑对话框 | 「公共标签」复选框组 |

一句话：**公共标签是项目级的"默认标签"，用来给整组会话打同一个维度，而不需要逐个会话去勾。** 它不参与验收、不影响执行，也不写入会话自身的 `tagIds`。

## 3. 目标模型（v10）

```text
board
  tagGroups: [ { id:'__project__', name:'项目', system:true, order:0 },
               ...用户组 ]          // 全部单值，无 mode 字段
  tags:      [ { id, name, color, groupId, revision,
                 carriedTagIds?: string[]   // 仅 __project__ 组的标签使用：公共标签
               } ]
  cards:     [ { ..., tagIds: string[] } ]   // 不再有 projectId
  orders:    { status, tag }                 // orders.project 删除
  // 不再有 projects
```

派生规则（纯函数，前后端共用）：

```ts
projectTagId(board, card)   = card.tagIds 中第一个属于 __project__ 组的值（至多一个）
projectOf(board, projectTagId) = tags.find(t => t.groupId === '__project__' && t.id === id)
projectTagsOf(board, card)  = projectOf(board, projectTagId(board, card))?.carriedTagIds ?? []
effectiveTags(board, card)  = card.tagIds ∪ projectTagsOf(board, card)
```

- 未归属 = `projectTagId(board, card) === null`
- 生效标签按组去重：**会话自身值优先**，项目携带的值只在同一组没有自身值时生效（`effectiveTags` 按组取一个值）。这样"单值"对筛选与展示同样成立：同一组在界面上永远只显示一个值。
- 项目顺序 = `orders.tag` 中 `__project__` 组内的顺序（其余组的顺序互不干扰：顺序表按组切片）
- 删除项目 = 删除该标签值（`delete_label` 级联：成员卡片移除该 tagId，历史 `project` 事件仍记录原 id）
- 项目改名/改色 = `update_label`
- 新建项目 = `create_label({ groupId:'__project__' })`

## 3.1 已落地的形态：持久化 tag-only + 运行时投影（v10）

为避免一次性改动 API/RPC 与两个兄弟插件，v10 采用**两种形态、一对纯函数转换**：

| | 持久化（SQLite `board.payload`） | 运行时 / 快照 / API |
|---|---|---|
| 项目 | `tags` 里 `groupId === '__project__'` 的值（携带 `carriedTagIds` 公共标签） | `board.projects[]`（由项目标签推导） |
| 卡片归属 | `card.tagIds` 中的一个项目标签 | `card.projectId`（由 tagIds 推导） |
| 顺序 | `orders.tag`（含项目标签） | `orders.project`（项目标签顺序 + EMPTY）+ `orders.tag`（其余标签） |
| 校验 | `parseStoredBoard()`：规范格式、每组单值、公共标签只在项目标签上、项目组必须是内置组 | `parseBoard()` 原有校验不变 |

```ts
toStoredBoard(board):  projects → tags(__project__, carriedTagIds) ; card.projectId → tagIds[0]
fromStoredBoard(stored): tags(__project__) → projects ; 项目标签 → card.projectId
```

写入路径（`mutate` 提交）先用 `parseStoredBoard` 校验持久化形态，再落盘；读取路径先 `parseStoredBoard` 再投影回运行时。因此"同组单值"在写入与读取两端都成立，UI 与 RPC 完全不用改。

项目标签组在 v10 里是**内置组**（`builtin: true`），名称「项目」，不可改名/删除；它的值就是项目，可以在标签管理器里改名、改色、增删（下一步 UI）。

## 4. 迁移 v9 → v10

在 `SqliteBoardStore` 打开 v9 库时，同一事务内完成（与 v8→v9 相同的模式）：

1. 建内置组 `__project__`（`system: true`, `mode: 'single'`），名字取默认「项目」。
2. `projects` → `tags`：`{ id, name, color, groupId:'__project__', revision, carriedTagIds: project.tagIds }`，保留原 id。
3. 卡片：`card.tagIds = [...(projectId ? [projectId] : []), ...card.tagIds]`，删除 `card.projectId`。
4. 顺序：`orders.tag.ids = [...原项目顺序（去掉 EMPTY）, ...原标签顺序]`；`orders.tag.revision += 1`；删除 `orders.project`。
5. 标签条件里保存过旧 id 的（`filters.tags`、`preferences` 已裁剪，无需处理）。
6. 校验与摘要：用 v10 `parseBoard` 重新校验、重算 `digest`、写 `schemaVersion = 10`、`user_version = 10`。
7. 迁移前校验：项目中若存在**已被删除**但被引用的标签 id（理论上不会），直接失败并保留原库，不静默修数据。

数据和历史都不删：`business_history` 里的 `project` 事件保留原 `projectId`/名称快照；`domain_events` 同理。

## 5. 命令与公开 API

| 现在 | v10 | 兼容 |
|---|---|---|
| `create_project{name,color,tagIds}` | `create_label{groupId:'__project__',name,color,carriedTagIds}` | 旧命令保留为别名一个版本，内部转译 |
| `update_project{projectId,expectedProjectRevision,...}` | `update_label{id,expectedRevision,...}` | 同上 |
| `delete_project{projectId,confirmed}` | `delete_label{id,confirmed}`（级联移除成员 tagId） | 同上 |
| `join_project` / 拖入项目 | `set_group_value{groupId:'__project__', value:id \| null}`（或复用 `set_card_tags`） | 内部转译 |

公开投影（`parseSnapshot` 之后、序列化之前）：

```ts
board.projects = tags.filter(t => t.groupId === '__project__').map(t => ({ id:t.id, name:t.name, color:t.color, tagIds:t.carriedTagIds ?? [], revision:t.revision }))
card.projectId = projectTagId(board, card)
```

投影是**只读派生**，不参与校验、不写回；`/api` 的 `Project` 类型与 `Board['cards'][n]['projectId']` 保持可用，兄弟插件不需要改。若某天要去掉投影，先发一个带 deprecation 的版本。

## 6. UI 变更

1. **项目总览**：项目卡由 `__project__` 组的值生成（外观不变）；"新建项目"= 新建该组的标签值。
2. **标签管理器**：项目组置顶且内置（不可改名/删除），可增删值、改色、删除；**已实现**（「项目（内置标签组）」区块，复用项目命令）。
3. **会话详情**：标签按组渲染单选行（同一组一个值，再点取消），未分组标签是一行；项目归属仍只读展示，移动走拖放/加入项目。**已实现**。
4. **未归属/已归档**：未归属 = 无项目组值；归档不变。
5. **筛选**：标签条件可以选择"任意组 = 任意值"；单值组天然互斥，多值组保持"满足全部条件"。
6. **视图**（后续增量，不在 v10 首批）：`View = group by <任意单值组>`，项目只是默认视图。

## 6.1 v11 增量（已实现）

- 持久化新增 `orders.tagGroup`：标签组与状态、标签一样有稳定的自定义顺序，v8/v9/v10 库在同一事务内升级到 11 并补齐该顺序；运行时视图仍由同一份维度顺序驱动。
- 标签管理器默认折叠：每个维度只显示摘要（有几个组、几个值），点击标题才展开编辑区；标签组行带 ↑/↓，与状态顺序共用同一套 `reorder` 命令（`dimension: 'tagGroup'`）。
- 右上角状态汇总泛化为筛选 selector：面板按「状态 → 项目 → 各标签组 → 未分组标签」逐行列出带全局计数的可选值；普通点击在同一维度内替换选择，Shift+点击在同一维度内多选（组内「或」、维度之间「且」）；触发器只显示生效值数量，筛选只收窄项目卡片与其内部会话，未归属/归档区块不受影响。
- 筛选只有一个入口（右上 selector）：未归属 / 已归档区块同样被收窄，计数覆盖所有未归档会话；旧的 Loki 风格高级标签筛选器已移除。筛选只是视图，不写数据。

## 7. 风险与回滚

| 风险 | 处理 |
|---|---|
| 116 处 `projectId` 引用遗漏 | 只保留一个派生函数 `projectTagId()`，其余全部改用它；`tsc` 会拦住旧字段访问（卡片类型去掉 `projectId`，投影类型单独声明） |
| 兄弟插件的 `card.projectId` | 快照投影继续提供 |
| 删除项目语义变化 | 与现在一致：卡片移除归属，会话、聊天、历史不删；命令保留 `confirmed` |
| 单值约束与旧数据 | 迁移时若发现某卡在同一组有多个值（老数据可能这样），**迁移失败并保留原库**，不猜、不静默丢弃；`docs` 里给出修复指引（人工或一次性脚本）。实测当前库：0 个标签、0 个组、39 张卡全无标签，本次迁移风险为零 |
| 回滚 | v10 无降级路径。迁移前自动在数据目录写一份 `dashboard.sqlite.v9.bak`（只读副本），并记录迁移版本到 `dashboard_meta` |
| 一次性改动太大 | 分两次提交：(a) 后端 v10 + 迁移 + 投影 + 旧命令别名（前端仍读投影，行为不变）；(b) 前端改用项目组标签并删除 `projects` 读取路径 |

## 8. 测试计划

- 迁移：真实 v9 库副本 → v10；断言语义等价（项目数、归属、公共标签、顺序、历史不变）；迁移失败时原库字节不变。
- 约束：同组两个值在命令层与 `invariants` 层都被拒（含项目组与未分组）；`add_card`/`edit_card`/`set_card_tags` 三条写入路径都覆盖。
- 投影：`board.projects` / `card.projectId` 与标签一致；只读（不写回）。
- UI 回归：项目卡渲染、新建/编辑/删除项目、拖入项目、未归属/归档、标签管理器、筛选。
- 兼容：`session-dashboard-automation`、`baseline-scheduler` 的集成测试不改一行仍通过。

## 9. 明确不做

- 一个会话属于多个项目（需要重定义项目卡、计数与拖放）——单值规则本身已经排除它。
- 组内多值（本项目不再支持；若以后要放宽，只能对**指定组**加回 `mode: 'multi'`，不能全局）。
- 把项目顺序与标签顺序拆成两套（v10 合并为一套，按组切片）。
- 删除项目公共标签（保留；如需删除另开一个「只保留会话标签」的迁移）。

## 10. 未决点（一句话确认即可）

「未分组标签」是否也视为一个单值隐式组：本稿默认**是**（规则无例外）。若你希望未分组标签可以随便多选（把它当作"临时便签"而不是一个类别），我把它改成豁免项，其余组仍单值。

---

## English abstract

Projects are a second dimension today, not tags: `board.projects` with `card.projectId` (at most one) sits beside `board.tags` with `card.tagIds` (any number, no per-group cardinality). The proposal makes a project one value of a built-in tag group `__project__`, and makes **every** tag group single-valued (at most one tag per group per session, ungrouped tags included as one implicit group), so there is no `mode` field and any group can serve as a view dimension. Project public tags stay as `carriedTagIds` on that value, with the session's own value winning when both target the same group. Existing `board.projects` and `card.projectId` survive as read-only projections in snapshots so sibling plugins keep working, while the store migrates v9 → v10 in one transaction (with a backup copy and no downgrade path). UI work is split into a backend-first commit that changes no behaviour and a follow-up that reads project tags directly.
