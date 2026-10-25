# 会话仪表板扩展开发 · API v2

面向给会话仪表板添加按钮、徽标、报告或后台提醒的插件开发者。核心 `0.7.0` 使用 API v2 / 数据库与 Board schema 11；本机验证环境、支持版本与打包范围见[中文说明](<../README.md>) / [English guide](<../README.en.md>)，不据此推定其他平台或在线 HMR 已通过。

## 1. 接入与 v1 升级

两个公开入口的导入都不会启动核心服务或创建页面：

- `@hsx/dsh-session-dashboard/api`：只读后端连接、类型及严格 Zod schema。
- `@hsx/dsh-session-dashboard/slots`：五个前端位置、组件参数及局部渲染边界。

**v1 明确不受支持。** 缺失版本或 `apiVersion:1` 的扩展调用拒绝，不把自定义状态伪装成旧三状态，也不返回误导的空结果。需要版本检查的服务在读取/修改前报 `UNSUPPORTED_API`；不符合严格 RPC 参数形状的请求也可能直接在协议边界拒绝。旧 `service.connect()` 无参数不再可用，必须采用 v2。

`connectDashboard(ctx)` 自动选择导入包的 `DASHBOARD_API_VERSION=2` 并向服务传 `{apiVersion:2}`。若绕过 helper 直接调用服务，必须同样提供版本；不要从复制的旧 bundle 导入 helper 后假定它会协商新模型。

```ts
import type { Context } from '@deepseek-ai/cordis'
import { connectDashboard, DASHBOARD_API_VERSION } from '@hsx/dsh-session-dashboard/api'

export const inject = ['sessionDashboardExtensions']
export function apply(ctx: Context): void {
  const lease = connectDashboard(ctx)
  ctx.effect(() => () => lease.close(), 'example: dashboard read lease')
  const hello = lease.handshake()
  if (hello.apiVersion !== DASHBOARD_API_VERSION || !hello.capabilities.query.available) return
  void lease.snapshot().then(snapshot => {
    // 不是修改核心的权限；若继续异步工作，仍需核对服务、范围和目标版本。
    console.log(snapshot.cards.map(card => card.placement.kind))
  }).catch(error => ctx.logger('example').warn(error))
}
```

支持某个 DSH 版本不代表该版本具备全部扩展或侧栏能力。先 handshake，再按 capability 的 `available/reason` 决定行为；包版本、槽位名称或组件可渲染本身都不是执行授权。

## 2. 只读连接

| 方法 | 契约 |
| --- | --- |
| `handshake()` | 同步返回 API 版本、本次 `serviceId`、`scope` 与能力 |
| `snapshot()` | 返回同一次数据库读事务的完整卡片摘要、项目、`boardRevision/highWatermark/retainedFrom` 和 handshake |
| `events(after, limit=100)` | 按 sequence 升序补读，最多 200 条；返回 `nextCursor/highWatermark/retainedFrom/gap` |
| `subscribe(listener)` | 只提示数据可能变化；需再次读快照/事件，不保证通知不丢失，返回取消订阅函数 |
| `close()` | 释放租约及订阅，可重复调用 |

连接绑定实际加载的 Cordis 插件注册，而非自报 `pluginId`。调用注册撤销、服务卸载/替换或数据范围失效后必须重新连接。snapshot 会同步可被动读取的宿主记录，不为了列出数据启动尚未加载的 Agent。快照事务一致不表示宿主在返回后不会变化。

租约没有 mutate、inspectSession 或 history 方法。公开导出历史类型/schema 也不等于增加了同名 lease 接口。它不授予浏览器身份、自动验收、运行命令、发送数据或任意状态写入权限；同进程检查用于正常协作，不能隔离恶意插件代码。

### 能力字段

`query/events/completionReplay/evidenceCheck` 以及新增的 `projectWorkflow/businessHistory/sessionInspection/sidebarEntry` 都要单独判断。`completionReplay` 只覆盖完整且已验证的持久来源；`evidenceCheck` 不判断成果质量。`businessHistory` 表示核心有业务历史能力，不表示只读 lease 提供任意历史查询方法。

`sidebarEntry` 当前由后端保守标为不可用：后端无法仅凭 SDK 版本证明浏览器侧槽位和实测结果，前端可使用其实际可用入口；该入口不依赖仪表板内的加入 UI，仪表板也不再提供加入已有会话的入口。`nativeSidebarFilter/isolatedExecution/externalDelivery` 未开放，不得将专用侧栏按钮解释成整行拖动协议、原生成员过滤或执行权限。

## 3. v2 数据：三种位置、冻结来源和标签来源

### 卡片摘要

`CardSummary` 保留会话/成员、标题、项目、运行状态和证据字段，新增：

| 字段 | 含义 |
| --- | --- |
| `status` | 最近内置执行处置：`in_progress / pending_review / accepted`，不是当前主列的唯一依据 |
| `placement` | 当前唯一主位置：builtin/custom/unset，见下例 |
| `origin` | 当前轮的冻结状态来源，或明确未指定原因；无轮次时 null |
| `workflowRevision` | 工作位置、来源和相关绑定变化的版本，与 metadata/lifecycle 分开 |
| `tagIds` | **仍然仅是会话自身标签**，保持旧字段含义 |
| `projectTagIds` | 当前项目公共标签；不写入会话自身标签 |
| `effectiveTagIds` | 去重的自身+项目标签；读取该字段不自动扩大任何旧规则的匹配范围 |
| `turnEnd` | 宿主 `turn/end.reason` 的判别联合，缺省/未知为 null；见下 |

```ts
// Placement
{ kind: 'builtin', status: 'pending_review' }
{ kind: 'custom', projectId: 'project-id', stateId: 'state-id' }
{ kind: 'unset' }
```

`turnEnd` 只透传系统结束事实，不是仪表板状态，也不由插件补造：

```ts
type TurnEnd =
  | { kind: 'completed' } | { kind: 'blocked' } | { kind: 'max-tokens' }
  | { kind: 'interrupted' } | { kind: 'forked' }
  | { kind: 'aborted'; cause: 'user' | 'parent' | 'hook' | 'disposed' | 'legacy' }
  | { kind: 'error'; error: { code: string; status?: number } }
```

来源是 `dsh-session` 的 `turn/end.reason`：`completed` 正常结束、`blocked` 目标受阻、`max-tokens` 达到输出上限、`interrupted` 崩溃孤儿轮次（冷读由 session-query 合成）、`forked` 因分支结束、`aborted` 携带取消原因（`user` 即手动停止）、`error` 携带结构化 LLM 失败 `code/status`（不包含 message）。未闭合执行没有 closer，`turnEnd` 为 null；宿主将来新增的 kind 在仪表板扩展该联合前也不会写入，因此读取方只需处理上表变体与 null。

已通过后选择自定义状态，`status` 可继续为 accepted，`placement` 已是 custom。不能只读 status 把它算到内置已验收列；自定义“完成”也不意味着人工通过。项目中的 `states` 有稳定 ID、名称、颜色、revision 和 disabled，数组顺序仅为展示。`PublicSnapshot.projects` 返回完整项目，不再只有 id/name。

来源为下列判别联合：

```ts
// EpisodeOrigin
{ kind: 'state', episodeId, episodeOrder,
  state: { projectId, projectName, projectRevision, stateId, stateName, stateRevision } }
{ kind: 'unspecified', episodeId, episodeOrder, reason }
```

`reason` 是 `legacy / before_membership / no_state / unverified_start / cross_project / source_unavailable`。所有名字和版本按当时事实冻结，不用最新名称填充旧轮；相同名字不表示同一项目或状态。加入前执行、延迟同步或无法可靠证明开始状态时未指定是正常结果，不是要求扩展“修复”的缺字段。

`completionCoverage='complete'` 证明持久日志覆盖，不证明当前来源在线或有人工权限。`sourceLive=false` 的冷历史即使证据完整也不能验收，不能成为自动化当前核查或提醒目标。扩展不得把 coverage 与 live/current 合并为一个“已验证”标志。

### 当前性与缓存身份

| 标识 | 作用 |
| --- | --- |
| `scope.scopeId/storeId/recoveryId` | 数据范围、数据库及恢复身份；防止跨 profile/恢复混用 |
| `serviceId` | 服务本次加载实例，后端重载不沿用旧动作 |
| `membershipId` | 本次加入，移出重加获得新 UUID |
| `episodeId` | 当前真实执行轮次，不由状态名或数字 revision 代替 |
| `metadataRevision/lifecycleRevision/workflowRevision` | 不同编辑/运行/工作绑定的并发版本 |
| `cancellationGeneration` | 使旧提醒/报告失效的版本，包括归档、来源、项目、工作状态及相关公共/合并标签变化 |

ABA 状态变化或项目移出再移回也使旧任务失效，不因最终值相同继续执行。`sourceIdentity/sourceCursor/completionCoverage/completionEvidenceDigest` 用于可靠来源与完成证据，不等于上述身份。

前端 `DashboardCardView.cancellationGeneration` 是 `number | null`；null 明确撤销“当前结果”展示，不能回退为 0。它来自核心快照的可选 `memberGenerations`；缺失表示未知。完整只读后端 CardSummary 的取消版本是数字；UI 传来的摘要仍不是完整后台证据或权限。

## 4. 变化事件与持久业务历史

### 扩展事件

`DomainEvent.schemaVersion=2`。保留 `joined/removed/metadata/archived/restored/host_archive/episode_started/completed/decision/source_gap/source_baseline`，增加 `workflow/project`。每条有 UUID eventId、独立单调 sequence、scope、member、episode、时间、Board 版本、摘要及可选证据。

- 核心把来源日志处理位置、摘要链、状态变化、事件及回执放在同一事务；订阅通知只在提交后发出。
- 首次来源确认是 `source_baseline`，首次加入为 historical，不能当成新完成。completed 来自已保存原始日志的逐轮回放，不是仅对比最新状态。
- 完成证据由 `sourceIdentity/sourceCursor/episodeId/evidenceDigest` 共同标识。最新日志位置可能因无关事件继续增长，不要求等于某轮结束位置；已经开始新轮时仍可补读旧 completed，但默认不针对旧轮执行新任务。
- `completionCoverage='unavailable'`、source_gap 或无法还原等待时暂停逐轮功能；临时失败恢复前检查旧前缀完全一致。身份变化、截短或改写后，状态选择和自动化证据核查不能仅靠重新同步恢复，需用户显式移出再加入建立新基线；已有 origin/历史不重写，旧成员任务仍须失效。移出会删除当前看板元数据，不是无损修复。
- 单份日志上限 100,000 事件 / 32 MiB，问题等待还原累计检查上限 2,000,000；超限不返回看似完整覆盖。事件队列 30 天 / 50,000 条，过期游标明确 gap。
- 迁移到 v2 事件前用冻结 v1 schema 验证旧事件，再原子清理；highWatermark 不回退，retainedFrom 设为 highWatermark+1。旧游标缺失时重建基线，不冒充空事件成功。

扩展自己的去重、游标和任务也须同事务保存，保存后再推进游标。首次启用从快照 highWatermark 和已核对日志位置建立起点，排除启用前完成、启用后才读到的记录。事件可重复处理；不能仅凭 requestId 宣称外部动作 exactly-once。

### 业务历史

业务历史与事件队列分开，最多每 member 1,000 / store 100,000 条，不按时间过期。`HistoryRecord.schemaVersion=1`，kind 为 `legacy_decision/episode_started/state_changed/project_moved/accepted/returned/reopened`。记录 sequence、成员/轮次、at、origin、from/to placement、fromProjectId/toProjectId、冻结 `fromProject/toProject/fromState/toState`、decision 与 requestId。旧记录没有保存的名字为 null，不伪造个人身份或旧执行。

已认证核心浏览器 RPC `history({sessionId,membershipId,after?,limit})` 按 sequence **升序**读取，最多 100 条；响应 `records/nextAfter/retainedFrom/highWatermark/truncated/gap`。truncated 表示容量裁剪，gap 表示显式游标不可用。无 after 从当前保留起点读，不自动把旧 membershipId 重绑新成员。历史 schema 的公开导出用于类型/校验，不赋予后台只读租约这一 RPC 的调用权限。

## 5. 核心浏览器 RPC 与人工操作边界

以下九个方法属于已认证浏览器的 `sessionDashboard` namespace，不是新增扩展写权限：

| 方法 | 当前参数与结果 |
| --- | --- |
| `handshake()` | DashboardHandshake |
| `snapshot()` | `{board: Board(schemaVersion:3), health, memberGenerations?}` |
| `candidates(query)` | 既有筛选/分页 CandidatePage，默认 untracked+active；公开 API 保留，仪表板 UI 已不使用 |
| `inspectSession({sessionId})` | `{snapshot,candidate,binding}` 的精确单会话读取 |
| `history({sessionId,membershipId,after?,limit})` | HistoryPage，最多 100 |
| `mutate({apiVersion:2,serviceId,requestId,command})` | 更新后的 Snapshot |
| `navigation(query)` | 重新核对运行与宿主归档后的 NavigationResult |
| `extensionSnapshot({apiVersion:2,serviceId?})` | PublicSnapshot |
| `extensionEvents({apiVersion:2,serviceId?,after,limit})` | EventPage，最多 200 |

`SessionInspectionBinding` 为 `{serviceId,boardRevision,membershipId,metadataRevision,lifecycleRevision,workflowRevision,runtimeFingerprint,sourceIdentity,sourceCursor,hostArchiveGeneration}`，其中成员、三种卡片版本、来源身份/位置按 schema 可为 null。add_card 会重新读取并精确核对；成员缺失不等于未知，后端不会用候选列表搜索结果代替 inspectSession。单凭 ID/MIME/binding 不取得权限。

项目命令包括 `create_project/update_project/create_state/update_state/reorder_states`；状态停用而不硬删。`choose_state` 使用明确 custom/unset；`move_project` 使用 preserve/custom/unset，并检查目标项目版本；`edit_card` 不含 projectId。`review` 明确 stay/custom，accept+custom 原子提交；return/reopen 只能 stay。所有涉及卡片的人工写入检查 membership，执行/状态操作另带完整 WorkflowBinding 与目标项目/状态 CAS；旧确认不自动切换新轮或去向。

错误通过 `dashboard/error` 的 `details.reason` 提供稳定代码，如 `CONFLICT/REVIEW_STALE/UNAVAILABLE/FORBIDDEN/UNSUPPORTED_API`，可带 `messageKey/params`。不要仅匹配中文 message。权限与调用取消在异步读取后和提交前复查；租约不能保存浏览器上下文冒充用户。

## 6. 前端扩展位置

| 槽位 | 参数类型 | 范围 |
| --- | --- | --- |
| `session-dashboard.toolbar.action` | `DashboardGlobalOwner` | 顶部按钮 |
| `session-dashboard.summary.widget` | `DashboardGlobalOwner` | 汇总，须明确全局/项目/可见范围 |
| `session-dashboard.card.badge` | `DashboardCardOwner` | 只读徽标，不放按钮/链接/输入 |
| `session-dashboard.card.menu.item` | `DashboardCardOwner` | 与核心打开详情分开的单会话动作 |
| `session-dashboard.detail.section` | `DashboardCardOwner` | 只读报告或扩展自行可恢复的内联输入 |

```ts
import { createElement } from 'react'
import type { Context } from '@deepseek-ai/cordis'
import type {} from '@deepseek-ai/dsh-client-ui-renderer/client'
import { withContributionBoundary, type DashboardCardOwner } from '@hsx/dsh-session-dashboard/slots'

const Badge = withContributionBoundary('@example/review-helper:badge',
  ({ card }: DashboardCardOwner) => createElement('span', {}, card.placement.kind))

export function apply(ctx: Context): void {
  ctx.slots.inject('session-dashboard.card.badge', () => ctx.slots.register({
    name: 'session-dashboard.card.badge', id: '@example/review-helper:badge', order: 30,
  }, Badge))
}
```

等核心声明槽位后注册，核心卸载时由 inject 生命周期清理，重载重新注册。不要在每次 React 挂载注册，也不查询/重写私有 DOM。ID 带包名；需要稳定先后使用不同 order，不保证同 order 重启后顺序。

`context` 含 handshake（未就绪/断连时 null）、entry、projectId 与 uniqueVisible。entry 可以是 projects/project/board/review/attention/unassigned/archive。`card` 是只读展示摘要，包含 placement/origin/三类标签，不包含完整日志证据。`occurrenceId` 区分多标签列中的独立界面状态。`actions.openDetails()/requestReview()` 只请求核心打开详情或人工核对，仍须服务/成员/轮次复核，不能代替用户确认或直接通过。

同一 root/list 注册的 inject/store 可跨卡片共享，不用一个 shared currentCard 保存所有菜单。实体缓存按范围、member、episode、workflow 和取消版本区分，展开/输入按 occurrenceId 区分；异步返回先核对当前性，卸载或范围变化后丢弃旧结果。没有扩展时核心独立工作，不显示空区。

`withContributionBoundary` 只捕获当前子树渲染错误，不能隔离所有依赖注入、注册、事件和异步错误。如果宿主已停止显示该注册，需注销重注册。复杂 Portal 弹窗、嵌套焦点与统一扩展未保存表单保护不在本版；不要假定核心会保护扩展输入。文本按文本渲染，不能注入未验证 HTML。

## 7. 自动化与未开放能力

独立自动化 `0.2.0` 声明的核心范围仍是 `^0.3.0` / API v2，尚未随核心 0.7.0 更新，因此不能与当前核心混用；自动化数据库为 schema 2，旧 `0.1.x` 也不能混用，配套升级前先一致备份两库。默认关闭，安装/启用 bundle 不自动授权规则；明确授权后仅本地提醒、插件内通知与执行结束证据核查。

旧 pending 任务不能补齐 v2 字段后重绑执行；新增状态或验收去向不触发下一轮。来源离线/未知暂停该目标的核查和提醒，不影响其他可用目标的规则计划；已失效报告永久保持非 current，恢复在线不复活旧报告或任务。规则 tagIds 仍只匹配 own；本轮不提供 project/effective 规则范围入口，升级不扩大范围。第三方如另行实现新范围，也必须显式取得用户配置，不能暗改旧字段语义。

本版不开放自动验收、AI 质量判断、仓库测试、命令/Agent 执行、外部消息、原生侧栏成员过滤、第三方自定义筛选或分组/视图。槽位存在、请求有 UUID 或报告标为通过，都不构成这些能力的安全与授权依据。
