# Session Dashboard 技术设计 · 0.3.0（历史）

> 本文是 0.3.0 时期的设计记录；当前实现（0.7.0 / schema 11）以 [README](<../README.md>)、[CHANGELOG](<CHANGELOG.md>) 和[项目即标签设计](<PROJECT-AS-TAG-DESIGN.md>)为准。文中的看板列、顶部标签页等界面已经移除。

本文记录 `0.3.0` 本地交付版已实现的项目中心契约与安全边界，采用[产品设计（中文）](<PRODUCT-DESIGN.md>) / [Product design (English)](<PRODUCT-DESIGN.en.md>)的 D01–D06 与本次用户授权采用的 R01–R06。本轮已完成下述 Linux 隔离验证，不代表所有平台、当前在线 GUI 或发布渠道已验收。使用流程见[中文 README](<../README.md>) / [English README](<../README.en.md>)，第三方接入见[扩展 API](<EXTENSION-API.md>)。

## 1. 范围、版本与入口

- 核心包 `@hsx/dsh-session-dashboard@0.3.0`；独立自动化 `0.2.0` 要求核心 `^0.3.0` / API 2，不并入核心。旧自动化 `0.1.x` 不兼容新核心，使用自动化时须备份并配套升级；其数据库为 schema 2，安装或启用 bundle 不自动授权规则。
- SQLite `PRAGMA user_version=3`，Board `schemaVersion=3`；公开扩展 `apiVersion=2`，变化事件 `schemaVersion=2`；业务历史记录 `schemaVersion=1`。这些是不同协议的版本，不相互替代。
- DSH 精确范围：`0.2.0-rc.1/rc.2`、`0.2.1-alpha.1/alpha.2/alpha.3/alpha.4`、`0.2.1-rc.1/rc.2/rc.3`；Node `>=22.13.0`。九版已在 Linux x64 / Node 22.23.1 / Chrome 150 逐版通过本轮构建、Node 与浏览器验证；rc.3 于 2026-10-24 补测：surface 61 包/66 imports、547 项 Node 全部通过，Chrome 本轮未重跑。不扩展未知 SDK；其他平台及 Node 版本未据此推定通过。
- 独立插件，不修改宿主源码、私有 DOM 或布局；不启动替代 GUI。正式后端入口为 `src/backend_index.ts`，前端为 `src/frontend_index.ts`，构建产物在 `lib/`。业务按 backend/frontend/shared 分层，手写构建/测试脚本保留 JavaScript。
- 顶层导航通过宿主 `sidebar.panellist` 与同 ID `main`；会话导航使用 `uiWorkspace.openSession`。原生侧栏仅通过公开行按钮/菜单槽位增加专用入口，缺少能力时不提供仪表板内加入已有会话的入口，不保证整行原生拖放。

## 2. 数据模型：当前位置不等于执行处置

### 项目和标签

`Label` 保留 `id/name/color/createdAt/revision`。`Project` 在其上增加 `tagIds` 与有序 `states`；每个 `ProjectState` 另有 `disabled`。状态身份稳定，数组顺序仅供展示，既不是固定流程，也不定义后继。项目名称、公共标签、状态或排列变化都会推进 `project.revision`；状态编辑还推进自身 `revision`。

项目公共 `tagIds` 引用 Board 的普通标签。`Card.tagIds` 始终只表示会话自身标签，不能暗改成继承集合。展示与公开摘要分别推导 `projectTagIds` 和去重的 `effectiveTagIds`；相同标签可保留两种来源。一个会话最多属于一个项目，标签匹配不创建成员关系，项目变化不改工作区或手工进展。

### Card 中相互独立的信息

| 字段 | 含义与约束 |
| --- | --- |
| `status` | 最近一次内置执行处置：`in_progress / pending_review / accepted`；不能单独用它决定卡片当前列 |
| `placement` | 唯一主位置：`{kind:'builtin',status}`、`{kind:'custom',projectId,stateId}` 或 `{kind:'unset'}` |
| `runtime` | 宿主实际执行情况、当前 `episodeId/episodeOrder`、日志位置、等待与同步状态；不由自定义名称推导 |
| `origin` | 当前轮次的冻结来源，或明确的未指定原因；没有轮次时为 `null` |
| `decision` | 已保存的当前人工决定；完整旧决定及去向另存业务历史 |

例如已验收后选择“待开发”，`status` 仍可为 `accepted`，而 `placement.kind='custom'`。这不等于仍在“已验收”列，也不表示下轮已开始。自定义“完成”不能映射成人工通过。状态筛选针对主位置的内置状态，`stateIds` 针对自定义状态；不能让隐藏的旧 `status` 覆盖实际位置。

`origin.kind='state'` 保存轮次及 `StateSnapshot`：`projectId/projectName/projectRevision/stateId/stateName/stateRevision`。`origin.kind='unspecified'` 的原因是 `legacy / before_membership / no_state / unverified_start / cross_project / source_unavailable`；不得用最新项目名、同名状态、标签或聊天内容补填过去。历史 `fromProject/toProject/fromState/toState` 同样冻结操作发生时的名称，旧版本未保存的内容明确为 `null`。

## 3. 来源证明、执行与人工提交

### 选择状态之后才开始的真实执行

当前状态不是过去开始时状态的证明。`placementWitness` 只在成功读取完整、当前可校验的来源并通过同步提交复核后建立，包含 `sourceIdentity/cursor/prefixDigest/workflowRevision/state`。`prefixDigest` 是该日志位置的 SHA-256 前缀链摘要，而非时间戳。

新轮绑定状态来源同时要求：来源身份一致、日志前缀摘要未变、工作版本一致、成员及项目有效，并且 `episodeOrder > witness.cursor`。早于或等于该位置、停机后才发现且无法可靠对应的执行显示未指定，不以同步时的最新状态回填。改名、公共标签或状态配置变化会撤销相关证明并推进工作版本；撤销的是对未来来源绑定的依据，不改写既有来源与决定。

### 原有运行事实边界保留

普通轮次以持久 `turn/start` 序号为基础，覆盖全部模型、工具及宿主后续处理。进入开始前置处理即暂停验收，但只有实际输入处理/模型步骤才形成真实工作。宿主可能生成无输入、无模型步骤的 completed 空转；只有实际 `step/start` 与配对正常 `turn/end` 才能进入待验收。工具返回、单条回复、Agent idle 或 registry dispose 均不充分。

Goal 自动续跑跨 turn 是一轮逻辑工作：active/armed 间隙继续处理中，active/disarmed 待恢复，paused/blocked/round-limit 不算完成。工具中完成 Goal 后仍须本轮正常收尾；同轮后续步骤保留已经建立的 Goal 身份。完成 Goal 的文字编辑和清除不重置有效结束时间或人工决定；未完成目标清除不借残留工具收尾伪造完成。仅明确 create/resume 或新的实际执行建立新轮，不让旧完成 Goal 吞并后来的用户提问。

实际用户取消以真实 aborted 边界判中断，idle Stop 不制造新工作。外部 pause 停止当前 turn 与工具内 pause 仅暂停续跑分开处理。结构化问题/授权等待可展示，宿主未暴露的任意插件内部等待不猜成完成。

### 工作版本与原子操作

- 保留独立 `metadataRevision` 与 `lifecycleRevision`；新增 `workflowRevision` 覆盖主位置、成员项目、当前来源及影响可操作绑定的证明变化。新成员版本从聚合单调版本初始化，移出重加不能复用旧 CAS。
- `WorkflowBinding` 包含 `sessionId/membershipId/expectedMetadataRevision/expectedLifecycleRevision/expectedWorkflowRevision/episodeId`。`StateTarget` 另检查 `expectedProjectRevision/expectedStateRevision`，不仅检查旧元数据版本。
- `choose_state`、`move_project` 与 `review` 先读取当前宿主事实。普通状态切换只允许可靠未执行且无待处理工作，或已通过的当前完成轮；未解决的执行不能用移动隐藏。
- `review` 的 `accept + destination:custom` 将决定、去向、历史、回执及卡片放在同一事务中；`stay` 是仅验收。return/reopen 只能 stay，不启动 Agent。取消不提交半份，同轮迟到完成不推翻已选择位置。
- 成员加入成功时直接采用 mutation 返回的快照更新看板（不再额外 snapshot）；失败时只刷新一次快照核对目标项目是否实际已加入，并在核对期间保留明确状态。

`move_project` 在当前内置过程中用 `preserve` 保留原来源；其他情况明确 `unset/custom`，目标项目为空时只能 unset，不按名称映射。`edit_card` 不再有 `projectId`，不能绕过专门移动校验。
- `delete_project` 需项目版本 CAS 与显式确认：删除项目、自定义状态、项目排序条目，并把成员的 `projectId` 清空、主位置改为 `unset`、`workflowRevision` 递增；会话、宿主聊天与历史不删除。
- 所有 mutation 外层为 `{apiVersion:2,serviceId,requestId,command}`，卡片写入携带 `membershipId`。每次人工操作 UUID `requestId` 与命令摘要一起持久化，相同请求只提交一次，不同内容复用 ID 拒绝；回执不按时间悄悄删除。
- 最后权限/宿主复核到数据 COMMIT 之间没有 `await`。只有 COMMIT 返回后才成功。独立宿主同步可能先提交，即使之后旧人工请求被拒绝；这不是部分提交验收。

## 4. 精确加入、RPC 与权限

`sessionDashboard` 命名空间提供十个严格 RPC：`handshake`、`snapshot`、`candidates`、`inspectSession`、`history`、`transcript`、`mutate`、`navigation`、`extensionSnapshot`、`extensionEvents`。共享 schema、正式实现与打包描述符须一致，不靠任意 patch 绕过判别联合。

`transcript({sessionId})` 只对已纳入看板的会话返回有界对话预览：按日志顺序展开 user/assistant/tool result，应用 surface replacement（压缩）以移除被替换节点，裁剪到最近 120 条消息并限制单条文本/工具输出长度；不读 system/developer 或生命周期事件，不发送消息、不启动或恢复 Agent。

`inspectSession({sessionId})` 对单个会话做真实当前读取，返回 `{snapshot,candidate,binding}`。`binding` 包含服务实例、成员存在/缺失、Board 与各 CAS 版本、运行摘要、日志身份/位置和宿主归档版本。`add_card` 携带该绑定并重新读取核对：缺失成员绑定 Board 版本，已有成员绑定精确成员与版本。ID、MIME 或一次查询结果不是权限；新添加不支持历史验收，也不初始化自定义状态。侧栏按钮不依赖仪表板已经挂载或启动轮询。

`candidates` RPC 作为公开契约保留，但仪表板 UI 不再使用，仪表板只创建新会话；该查询仍先对完整条件筛选再分页，默认 untracked+active；查询代次绑定成员及宿主完整列表，缓存顺序、归档变化或并发成员修改不会制造不真实总数。标题只为返回页窗口折叠（16 路并发、有界缓存），不参与筛选、计数或运行事实；未纳入候选的 `runtime` 为 `null`（界面显示为未知/冷），纳入时由 `inspectSession` 权威核验运行与归档。

RPC 仅允许真实已认证浏览器用户。旧版精确匹配 `connection.operator`；`0.2.1-alpha.3` 起匹配有效 `browserPeer`、owner principal 与 peer signal。API/远程 peer 自称 owner 不获得权限，Cordis 代理比较实际 Connection 服务身份。异步读取后与提交前复核，取消、替换和卸载使旧请求失效；Agent 工具不暴露验收方法。错误保留稳定 `details.reason` 与可选 `messageKey/params`，界面按宿主语言展示，不直接在英文页面泄露中文旧错误。

`snapshot` 的可选 `memberGenerations` 是同次事务内只读的成员取消版本，不入 Board。缺少条目表示未知，前端槽位用 `null` 撤销旧报告的当前性；不能把未知当 `0`，也不能从 UI 摘要取得后台执行权限。

## 5. SQLite、历史与迁移

选择 Node 内置 SQLite，为卡片、标签引用、关联、人工决定、来源位置、历史和回执提供跨记录事务。WAL + `synchronous=FULL`，5 秒 busy timeout；写入 `BEGIN IMMEDIATE` 后重新读聚合，不用进程缓存覆盖其他进程。

默认目录使用宿主公开的 `profileContext.dir`；缺省数据库为当前 profile 的 `data/session-dashboard/dashboard.sqlite`。格式错误立即拒绝，不从 cwd/default home 猜路径；仅直接 Cordis 组合缺少宿主上下文时兼容绝对 `DSH_PROFILE_DIR`。自定义绝对 `dataDir` 不改变 realpath + SHA-256 的 profile 绑定。创建目录/文件请求 0700/0600；这是 POSIX 模式，不等同于 Windows ACL 安全验证。

所有读取验证 JSON、SHA-256、规范形状及交叉引用；未知未来版本、无版本非空库、损坏或字段缺失均拒绝，不清库修复。无向关联边唯一，归档只影响可见性，不停止同步；从活动卡片修改关联不覆盖归档目标元数据。

### 两种记录不能混为一谈

| 记录 | 用途 | 保留与读取 |
| --- | --- | --- |
| `business_history` | 执行开始、人工状态调整、项目移动、通过/退回/重开及旧决定 | 每 member 最近 1,000 条、全库 100,000 条，无时间过期；逐行 SHA-256，裁剪和历史操作同事务 |
| `domain_events` | 扩展补读变化与完成证据 | 30 天 / 50,000 条滚动队列，过期游标明确 `gap`，不是永久业务历史 |

业务历史 `HistoryRecord` 保存 UUID、独立单调全局序号、会话/成员/轮次、发生时间、冻结来源及 from/to 项目与状态快照、决定、请求 ID。迁移仅把实际已保存的旧决定作为 `legacy_decision`，不制造更早历史或可验证个人身份。当前 Card 来源/决定不随历史裁剪消失。

`history({sessionId,membershipId,after?,limit})` 按 sequence 升序分页，最多 100 条；返回 `nextAfter/retainedFrom/highWatermark/truncated/gap`。没有 after 从仍可用记录开始；显式游标早于裁剪位置或超出该成员 highWatermark 时 gap，不静默重绑新成员。公开只读 lease 没有 history 方法，不能虚构同名后台入口。

### 长会话来源基线缓存

事件数 ≥5000 或持久日志 ≥8 MiB 的会话按长会话处理：`inspectSession`/`add_card` 不再整份回放，只用轻量观察加入卡片，来源由 `BaselineManager` 在后台建立。短会话继续走原有内联回放，行为与版本绑定不变。

`BaselineScheduler` 是唯一后台写入者：全局单 worker，同一时刻只有一个切片；每 1 秒窗口最多 200 ms 工作，切片目标 20 ms、硬上限 100 ms，切片间主动让出事件循环。每个切片默认最多 500 个事件，并按调度器传入的剩余预算进一步收紧，避免单次同步哈希/摘要计算长时间占用主线程。`BaselineManager` 只在短尾或用户操作需要时内联追赶，长日志返回 `running` 并排队。

每片从持久日志 `readSourceSlice(sessionId, fromCursor, maxEvents)` 读取连续事件，追加到 `SourceFoldBuilder` 的 `LifecycleJournal` 和摘要链；随后把 `SourceFoldCheckpoint` 原子写入 `source_folds`：会话身份、持久服务/修订、`headerDigest`、继承边界、游标、来源 identity、上一检查点边界与摘要、当前摘要、最多 1024 个历史切点、journal 状态和完成证据。检查点不保存整份前缀数组；`fromCursor/fromDigest` 与历史切点共同证明旧成员游标。每行绑定到 `sessionId`，并记录该切片对应的持久 `revision`；恢复时校验会话头/继承边界，日志截短、头变化或游标超出当前日志都会丢弃检查点并从零重建。

用户变更持有每会话 `hold`：排队中的后台任务被取消，正在执行的切片完成后不再续片、不写检查点；释放后原任务恢复。后台完成来源只写成员来源与 `source_baseline`/`completed` 事件，不提交新的运行观察，因此不会单独增加 lifecycle/workflow 版本，也不会让已打开的验收绑定失效。来源相关命令在基线未到达观察游标时返回明确的运行中/不可用状态；卡片只显示内联进度文字，没有遮罩，验收始终需要用户显式确认。

### v1/v2 → v3

冻结历史解码器先验证原始形状与规范性，在同一 `BEGIN IMMEDIATE` 内完成旧 v1→v2→v3、引用检查、新表与版本设置；失败回滚 DDL、数据和版本。保留现有成员/profile/scope/store/recovery 身份、版本、来源位置、取消版本、回执和已保存决定时间。旧项目增加空 `tagIds/states`，旧卡片以原 builtin status 展示；`workflowRevision` 从旧生命周期版本继承，witness 为 null，已知轮次来源明确 legacy 未指定。

旧扩展事件逐条用冻结 v1 event schema 检查摘要、范围和序号后才清理；保留 highWatermark，设 `retainedFrom=highWatermark+1`，下一批事件使用 schema 2。不能把旧 payload 补字段后当新协议，也不回退游标让旧消费者重放。

备份须停全部写入者并处理 WAL/SHM，或使用 SQLite 在线备份；不能拷贝活跃主文件作为升级回退。旧二进制拒绝新格式；任意手工回滚整套库不保证被自动识别。

## 6. 可靠事件与只读扩展

首次确认日志保存历史起点 `source_baseline`；后续完成事件来自已持久原始日志逐轮回放，与来源摘要链、已处理位置、卡片及回执一起提交。旧轮结束仍可记录，但新状态或新轮不能让旧扩展任务变成当前任务。临时来源缺失暂停，恢复时验证旧前缀完全一致；身份改变、截短或改写标记为需要新基线。此时即使最新运行事实可读，也不给状态选择建立新 witness，自动化证据核查不可继续，须显式移出再加入。该处理不重写已保存 origin 和历史；移出会删除当前看板元数据，文档须提醒先保存信息，不能包装成无损修复。

`sourceIdentity` 在摘要前把零值 `delegationDepth` 规范化到 header 的固定位置，避免 DSH 在不同路径上物化默认字段或改变属性顺序时把同一历史误判为新来源；早期省略该字段的 identity 作为兼容值保留。成员来源记录 `rebaselineKind`：`prefix` 表示真实前缀改写，只有显式重新基线才能清除；`identity` 或字段顺序造成的假缺口在旧 cursor 的前缀摘要重新对齐后自动恢复。

replay 结论按持久 revision + live seq 缓存，命中时跳过 flush/open/整读；32 MiB 判据逐事件累加并在超限前中止；仅在日志出现计时问题时还原问题投影。单份日志最多 100,000 事件、32 MiB；问题等待还原累计检查上限 2,000,000。超限明确不可用，不返回看似完整结果。已用 member 身份保留到 100,000 后拒绝新增，不复用旧身份。

API v2 只读连接由实际 Cordis 调用注册及生命周期绑定；`connectDashboard(ctx)` 显式调用 `connect({apiVersion:2})`。缺失版本或 v1 明确拒绝，不能三状态假兼容。`completionCoverage='complete'` 仅证明持久日志的覆盖，与当前 `sourceLive` 和浏览器人工权限正交；`sourceLive=false` 的冷来源即使证据完整，也不能据此验收或作为自动化当前目标。租约不授予浏览器身份、自动验收、任意写入或执行权限，也不隔离同进程恶意代码。

公开摘要区分 builtin/custom/unset、冻结来源、工作版本和三类标签。`cancellationGeneration` 在工作版本、项目/来源和影响匹配的公共或合并标签变化时增加，即使值最终 ABA 回到原样；旧任务须失效。新 capability 包括 `projectWorkflow/businessHistory/sessionInspection/sidebarEntry`；后端不能由版本猜浏览器槽位或验证结果，当前 `sidebarEntry` 保守标为不可用并保留按钮替代；nativeSidebarFilter、isolatedExecution、externalDelivery 不开放。

核心一次性在 main 声明五个原生 children 扩展位置，不随 React 重挂载重复注册。root store/inject 可跨多张卡共享；实体缓存按范围/member/episode/workflow/取消版本区分，界面展开按 `occurrenceId` 区分。`withContributionBoundary` 捕获当前子树渲染错误，不承诺隔离依赖注入、注册、异步或事件处理的所有错误。详情扩展以只读或自行可恢复内联输入为主，没有任意 Portal 协调或统一未保存表单保护。

自动化独立、默认关闭；旧 pending 任务迁移为不兼容/取消，不填充缺失 v2 字段冒充新任务。本轮自动化规则只匹配 own 标签，暂不提供 project/effective 规则范围配置。当前目标必须来源在线且同步已知，单个来源离线/未知同时暂停该目标的核查和提醒，不影响其他可用目标的规则和计划；旧报告一经失效永久保持非 current，回线不复活旧报告或任务，原证据仍可查看。状态选择与验收去向不启动执行或旧轮任务。不执行仓库测试、不判断 AI 成果质量、不外发。

## 7. 前端、双语与生命周期

新空 Board 默认 Projects，迁移保留旧入口/筛选。入口为 projects/project/board/review/attention/unassigned/archive；当前项目与各入口筛选独立，全局待验收和需我操作不受选中项目限制。标签可按 effective/own/project 来源筛选；状态列只放一次卡片，标签视图引用总数去重。

「需我操作」是纯派生的注意力层（`attentionKind`：等输入/等授权/需恢复/失败/中断/同步），不是 Board 字段，也不改 `status`/`placement`；它只在状态标签旁渲染一个小标记，原因来自 `runtime.attention`。状态颜色由 `view-model.statusColor(board, card)` 统一给出：内置四态分别为 info/info/warn/ok（进行中与待确认同色是有意的，运行中由动态 spinner 区分），自定义状态用自己的 `color`（缺失回退 faint），未设置用 faint，注意力标记与终端结论用 danger；状态 chip、下拉选项与列头共用该映射（自定义列头通过内联 `--sd-col-accent` 下发）。`terminalOutcome(card)` 只在 `status=in_progress` 且内置 `in_progress` 位置且 `turnEnd` 为终端异常时返回 interrupted/failed/stopped，chip 用它替换显示文字并改用 danger，不再渲染额外的 attention 标记，`title` 追加「看板状态仍为进行中」；存储状态与命令语义不变。`runtime.turnEnd` 是系统 `turn/end.reason` 的 1:1 透传，只在运行时出现、不进 Board 版本：`shared/model.ts` 用判别联合固定已知变体（`completed/blocked/max-tokens/interrupted/forked/aborted(cause: user|parent|hook|disposed|legacy)/error(code,status?)`），生命周期只写入联合内的 kind/cause，遇到未来未知 kind、未知 aborted cause 或缺失 `error` 身份时不写 `turnEnd`（不抛错、不改旧行为），等类型扩展后再开始透传；未闭合执行没有系统 closer，绝不冒充 `interrupted`。`error` 只保留结构化 `code/status`，不带 message。UI 的标记文字优先取 `runtime.turnEnd`（interrupted/max-tokens→已中断、error→失败、aborted user→已停止、其他 aborted→已中断、blocked→目标受阻），否则回落到派生的 `attention`；`title`/`aria-label` 优先使用 `runtime.explanation`。项目会话行另外渲染可见短标签 `sd-attentioninline`，失败/中断用 danger，等待类用 warn。
状态下拉是 `role=listbox` 的自定义面板：通过宿主 `react-dom` 的 `createPortal` 挂到 `document.body` 并 `position:fixed` 按触发按钮 rect 定位，避免项目会话区 `overflow` 裁剪；`--sd-*` 变量作用域因此包含 `.sd-statepanel` 自身，否则 body 下的面板拿不到 border/背景/文字色。入口在 `portal.ts` 注入，未注入时回退为同结构内联面板（便于单元渲染）。

页面请求仍按实例/代次和 Board revision 拒绝晚响应，写入 FIFO，偏好防抖 CAS，冲突不自动覆盖。详情未保存草稿含待创建标签名，进入原会话可显式保留；硬刷新不恢复。项目与状态编辑失败保留输入，需要明确载入最新版本；停用不硬删。所有拖动有按钮/键盘操作，Modal 处理焦点、Tab、Escape 和关闭保护。

界面以横向流式看板为主：列在宽屏共享剩余宽度、窄屏只在 `.sd-scroll` 内横向滚动，卡片按列宽自适应行数与内边距；项目总览按定宽单行卡片横向铺开并自动换行（标题与统计同排、边框较细），默认全部展开；每张卡的会话区在卡片内部向下延伸、宽度与卡片一致，固定 300px 高并内部滚动，行高取本行最高卡片，后续行自然下移（不建浮层、不向上翻转）；点击卡片可单独收起/展开；每行最左侧提供整行收起/展开控制，行首上方细线紧贴卡片顶边贯穿整行并在一端折成根号形（无边框行钮嵌在其中），新建项目虚线卡位跟随所在行高度（标签固定在左上角），卡片左上把手可拖动重排项目（指针拖动时实时重排预览，拖入右侧取消区或按 Esc 取消，左右方向键等价；顺序变化用 FLIP 位移过渡并遵循减少动态偏好），顺序写入现有 project 排序并保留未归属哨兵末位；行分组按容器实测宽度计算，不依赖 CSS 自动换行推断。内容区保留细边框、阴影与分层底色；只有卡片内的会话区不画外框。会话行状态条在 Agent 空闲且允许直接安排位置时是下拉状态入口，选择后立即提交 `choose_state`（无弹窗，当前状态禁用）。项目卡会话列表与看板列内统一按 `board.orders.status.ids` 排序，同一状态内按 `activityAt ?? joinedAt` 倒序，渲染时重新计算，不做跨渲染的稳定顺序缓存。 运行中的项目行用 `startedAt` 计算本轮已运行时长（绝对时间、每秒刷新；等待人工与冷快照不计时），显示时占用原有时间槽。会话行点击进入只读对话预览（宽 1000px 的二层浮窗，仅对话内容），行内仍提供详情；预览与详情抽屉都可再进入宿主会话。同一屏不重复同一动作：新建项目使用总览网格末尾的虚线卡位；打开项目看板的入口固定在卡片会话区底部；项目卡「项目操作」提供新建会话（每次弹出工作区选择器，工作区来自 workspaces 投影，创建全新空白会话并直接加入该项目）、编辑与删除；标题栏不再常驻新建项目 / 新建会话按钮，「更多操作」只收纳刷新、分类与排列等操作，不再提供添加会话或候选面板；筛选条「筛选」面板收纳筛选条件。面板关闭时不进入可访问树，Escape 关闭并把焦点还给触发按钮，菜单打开时不重复暴露已有可访问名称。

原生侧栏专用按钮只写自己的 MIME 并阻止源行排序事件冒泡；普通宿主 text/plain 不作为插件协议。落下只发起同一个精确加入/移动确认流程，不直接写成员、状态或恢复归档。点击路径和拖动路径使用同一后端复核，组件自行清理一次性请求，不要求先打开仪表板。

中英文跟随宿主 locale 服务，不自动翻译用户原始项目名、状态名或标签；不支持的语言回退到英文。市场资源使用公开导出的双语 locale JSON，安装 patch 仍只维护正式插件身份和配置，不增加未经宿主支持的元数据字段。

后台先订阅再读初值，15 秒同步跟踪会话，归档也参与；页面约 3 秒读取，隐藏/卸载停止前端请求，后端同步不依赖浏览器。卸载清监听、定时器、读取资源和数据库；旧请求/lease 不可写新实例。HMR 需 watcher、当前实例和生命周期真实验证，接收器存在或构建成功本身不证明当前 GUI 已更新。

## 8. 验证、CI 与交付

本轮八个精确 SDK 各通过正常空目录安装、严格构建、308 项 Node 回归和 32 项基础 Chrome，失败/取消/跳过均为零；不支持版本与缺少本地 SDK 的负例通过。A12 真实鼠标状态拖动另在八版各补测 1 项，既有运行产物前后摘要不变，不把原矩阵改称 33 项。该补充使用真实 Gateway/Service/SQLite，但 SourceReplay 为受控 fixture，不冒充完整在线宿主执行。

固定源码副本的锁文件安装、无继承产物重建、308 项 Node / 32 项基础 Chrome 与包内容检查已通过；这不称为原仓库的干净 Git 检出。生命周期在隔离的官方 ModuleLoader/SlotRegistry 中覆盖两次 dispose、重新启用及完整 bundle 加载，另有临时宿主重载验证；当前用户 GUI 的 watcher 与在线 HMR 更新链路未验证。双语、键盘及窄屏浏览器检查属于隔离环境，截图使用测试字体。

CI 配置覆盖 Ubuntu/Windows/macOS × Node 22/24 的基本测试、打包、隔离安装和 Chrome；八 SDK × Node 22/24 的矩阵配置保留在 Linux。本轮实际环境为 Linux x64 / Node 22.23.1 / Chrome 150；Windows、macOS、arm64、Node 24 与云端 CI 未执行，配置和平台模拟不替代原生证据。测试专用 web-frontend 仅为 devDependency，不进入 runtime peer、inject 或依赖包内容。

运行包白名单仅产物、bundle、图标和用户/API 文档；不混源码、测试、产品/技术设计或内部报告。最终交付树的独立检出重建与安装校验结果以随附交付验证记录为准；独立临时 Git 仓库的验证不表示原有 dirty/unborn 仓库已提交，也不表示云端 CI 通过。预构建包校验与真实 profile 安装、在线 GUI 生效、推送、tag、Release、npm 发布分别报告；真实安装、启用、重载和发布均未执行。
