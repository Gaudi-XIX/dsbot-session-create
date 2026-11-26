# 变更记录

按提交日期记。发布到 npm 的版本号以本文件与 `package.json` 一致。

## 0.12.0 · 2026-11-21

**终态回执落盘必达：receipt outbox 记账 + 重启补投；回执标记收窄为两种**

- **成因**：「欠派活方一条回执」这件事原先只活在进程内存里——`src/core.ts:1547 createDispatchNotifier` 在 `turn/end` 时起一个 `QUIET_WINDOW_MS`（120 秒）静默窗定时器，窗口到了才 `deliver()`，待投状态存于 `pending` Map 与 `notified` Set（`:1551`／`:1552`）。静默窗没到就重启、或宿主被直接杀掉，这一单的回执就永久丢失；台账只有 `markNotified` 写的 `notifiedAt`（`:941`），没有任何字段表示「还欠着」；启动自检 `installAutoResume`（`src/autoresume.ts:325`）只读 `restart-pending.json`，不会补投。派活方唯一的自救手段是自建一次性 deadline 提醒，而提醒只解决「等太久」，不解决「回执丢了」。根因是「决定」与「记账」都在内存里，与投递路径同生共死。
- **改动**：新增 `src/outbox.ts`（19 个导出，纯数据与 IO，不含投递逻辑）——落点 `<台账目录>/receipt-outbox.json`，`DSH_SESSION_CREATE_OUTBOX` 覆盖路径、`DSH_SESSION_CREATE_OUTBOX_DISABLE=1` 关记账；`ReceiptEntry` 记 `receiptId`／`sessionId`／`headSeq`／`dispatcherSessionId`／`returnTo`／`mark`／`turn`／`reason`／`endTime`／`status`（`pending`｜`delivered`｜`abandoned`）／`attempts`／`createdAt`／`lastAttemptAt`／`deliveredAt`／`closedAt`／`abandonedReason`；去重键 `receiptId = <sessionId>@<headSeq>`，同一段终态重扫多次读到同一 seq，天然幂等；`tmp` + `rename` 原子替换；退避 `30s→60s→120s→300s→600s` 后固定 600 秒、单条上限 40 次（`RECEIPT_BACKOFF_MS`／`RECEIPT_MAX_ATTEMPTS`）、只清已关闭且超 24 小时的账（`RECEIPT_RETENTION_MS`），`pending` 不按时间清。`src/core.ts` 把 `lastAssistantText` 拆成 `lastAssistantReply`（返回 `{ text, seq }`，`seq` 取命中那条 `assistant/message` 的事件序号）加一层薄包装，导出名与全部错误串保持不变；`createDispatchNotifier` 新增 `capture()`（在 `turn/end` 分支、静默窗之前记账，崩溃窗口从「整个静默期」缩到「一次 page 读取」）、`reconcile()`（扫盘补投，同会话只保留 `headSeq` 最大的一条，旧的按 `superseded` 销账）与 `stop()`；`deliver()` 改为返回 `DeliverOutcome`（`delivered`／`closed`／`pending`），投出去或判定永久失败即双向销账；重试走 `deps.setTimer` 单槽定时器，账上没债就没有定时器；`installDispatchNotify()` 挂完监听立刻 `reconcile()`，这是唯一的补投触发点；账读不出写不进只记一行日志（fail-open）。教学侧收窄为两种标记（`src/core.ts:48` 与 `src/index.ts:52`），解析侧 `TERMINAL_MARKS`／`terminalMarkOf` 一字未动，`[NEEDS USER]` 保留为 `[DISPATCH BLOCKED]` 的兼容别名。`README.md` 新增「回执落盘与重启补投（receipt outbox）」一节、标记表两行、deadline 节收窄为「过期待办提醒」、残余四条重写、启动自检锚点 `src/index.ts:303` → `:347`；`test/outbox.test.ts` 新增、`test/notify.test.ts` 扩 7 例、两份 `R1_INSTRUCTION` fixture 同步。`index.js` 由 `bun run build` 从 `src/index.ts` 重建，不手改产物。0.11.x 历史条目原样保留。
- **实测读数**：`bun test` = 232 pass / 0 fail / 844 expect() calls / 232 tests across 6 files（新增 `test/outbox.test.ts` 10 pass、`test/notify.test.ts` 57→65 pass，其中 1 例为 review-loop 补的同会话 supersede 集成用例）；`bun run build`（bun 1.3.13）重建 `index.js` 86.90 KB（86,897 字节，sha256 `23e8d5ce9828c5cbeb78bed097485ca9bbc8ef664ea98d016a86fc1d09fd8ce3`），产物内 `[NEEDS USER]` 命中 1（仅 `TERMINAL_MARKS` 兼容别名那一处），`setInterval(` 命中 0。

- **派会话模型跟随宿主默认（2026-11-26 补）**：`createSessionIn` 移除「读派活方模型并钉死、读不到整单拒绝（dispatcher-model-unknown）」的逻辑——未显式传 `model` 时新会话跟随宿主全局默认模型，显式传才经 `selectModel` 钉死；旧 README 硬规则 1 随 593 行级 README 重写废止。`TERMINAL_MARK_INSTRUCTION` 缩短为一句精简版（禁弹窗＋末行只写标记两种），改名失败不再阻断建会话。实测：`bun test` 230 pass / 0 fail / 839 expect() calls（bun 1.3.13）。

## 0.11.4 · 2026-11-20

**文案更正：session_message 的 idle 续投不再以终态标记或台账在途为门——idle 一律可续投**

- **成因**：`src/index.ts` 的 `MESSAGE_DESCRIPTION`、`src/core.ts` 的 `messageSessionIn` 注释、`README.md` 的工具要点／硬规则第 3 条／`session_message` 节／失败表，以及 `package.json` 的 `description`，仍写 0.9.0 的「idle 看末尾终态标记 + 台账在途决定 queue 续投或拒投」口径；0.10.0 已解除这道硬拦截，现行 `src/core.ts:1226-1231` 只看宿主状态：`idle` 一律 `mode: 'queue'`，无终态标记门、无台账门。终态标记只表示这一轮要向派活方回一条特定消息，不构成「会话已关闭、不能再续投」的判据。照旧文案调用会误判拒投，也违背「保持插件是纯粹的桥」这条原则。
- **改动**：`src/index.ts` 的 `MESSAGE_DESCRIPTION` 重写为 running→steer、idle→queue 一律可续投，写明终态标记只管回执；`src/core.ts` 注释同步；`README.md` 三处说明改写、失败表删掉已不存在的 `session-idle` 拒投行，标题下新增 ≤140 字精简版（101 字），新增 `ABOUT.txt` 作第二正本；`test/core.test.ts` 的 describe 标题与注释同步（断言未动）；`package.json` 版本 `0.11.3` → `0.11.4`、`description` 去掉过时的 "no terminal mark" 短语。`index.js` 由 `bun run build` 从 `src/index.ts` 重建，不手改产物。0.10.0 之前的历史条目原样保留。
- **实测读数**：`bun test` = 214 pass / 0 fail / 774 expect() calls / 214 tests across 5 files [1294.00ms，退出码 0]；`bun run build`（bun 1.3.13）重建 `index.js` 75.37 KB（75,368 字节，sha256 `da00d80a03d9fcdf82ac4ca86f9721092eedad6e8413918aa2eac860760cbf25`），产物内 session_message 的终态标记门命中 0，回执门保留 1 处（`index.js:951`，合法）。

## 0.11.3 · 2026-11-20

**文案修复：两处派单提示不再教 `after_seconds` 与 `schedule_delete`，改为真实可调通的 rrule 两行 + `schedule_edit` 删除形态**

- **成因**：`src/index.ts:53`（`CREATE_DESCRIPTION` 末条）与 `:220`（`deadlineNote`）教了本机并不存在的调度调用——`schedule_create` 没有 `after_seconds` 参数（只有 `rrule` / `prompt` / `target` / `title`），也不存在 `schedule_delete` 这个工具（删除走 `schedule_edit(action="delete", id=…)`）。派活方照现文案调，第一次调用就因参数不存在而失败，而这条一次性 deadline 正是「回执永远不来」时唯一的兜底，文案指错等于兜底链条在最关键的一步断掉。算法没错，错的是说明书。
- **改动**：`src/index.ts:53` / `:209` / `:220` 三处同步为真实形态——`rrule` 传两行（首行 `DTSTART;TZID=<IANA 时区>:<YYYYMMDDTHHMMSS>` 取当前本地时间加插件给出的分钟数，次行 `RRULE:FREQ=DAILY;COUNT=1`），删除用 `schedule_edit(action="delete", id=<task id>)`；「一次性、绝不周期巡检」「终态回执到达即删」「数值取自本工具返回」「`standard`/`ptc` 挂载、`minimal` 没有」四条原意逐条保留。`README.md:173` / `:175` 同口径改写（`:182` 只提工具名，复核后不改）；`test/notify.test.ts:880` 测试名与 `:893-903` 断言随新文案改写，并补 `expect(text).not.toContain('after_seconds')` 负向断言。`suggestDeadlineSeconds` 算法、台账读写、回执门一字未动；本文件历史条目里的旧串原样保留（历史记录，不是现役说明书）。
- **实测读数**：`bun test` = 214 pass / 0 fail / 774 expect() calls / 214 tests across 5 files [578.00ms，退出码 0]；`bun run build`（bun 1.3.13）重建 `index.js` 75.62 KB（75,623 字节，sha256 `bcd88ebddab5e62b5d91933af6ce5ce01a2804545e086793a6e06a11a5c80388`），产物内 `after_seconds` 与 `schedule_delete` 命中数均为 0，`RRULE:FREQ=DAILY;COUNT=1` 命中 2。
- **文档同步**：`README.md` 的「一次性 deadline 兜底」节两条改为 rrule 两行 + `schedule_edit(action="delete", id=<task id>)`；`package.json` 版本 `0.11.2` → `0.11.3`。

## 0.11.2 · 2026-11-17

**回执投递优化：派活方若在等待期已读过终态（lastReadSeq >= headSeq），跳过重复回执并记 notifiedAt**

- **成因**：派活方在子会话运行或收工等待期间若手动调用 `read_session_transcript` 读回了终态结论，后续完成回执（`deliver`）仍会往派活方队列塞入旁路回执，导致下一轮次派活方重复接收已读结论（双重事故）。
- **改动**：`src/core.ts:deliver` 在核验终态标记后新增 seq 比对；若 `typeof record.lastReadSeq === 'number'` 且 `record.lastReadSeq >= targetHeadSeq`，则向内存集合置 `notified.add(sessionId)` 并追加台账 `markNotified`，抑制重复 prompt 投递并打印日志。`test/notify.test.ts` 补齐已读免推与未读正常投递两条单元测试。
- **实测读数**：`bun test` = 214 pass / 0 fail / 771 expect() calls across 5 files [退出码 0]；`bun run build` 重建 `index.js` 75.22 KB（sha256 `936e8f3579a011ce612b890f701790b9fb7a66d1d77d13bc390edae05b2dcba8`）。
- **文档同步（发布前补正）**：`README.md` 的「派完自动回执」节补「派活方已读过终态就不再重投」的机制说明（`lastReadSeq >= headSeq` 即跳过本次回执并记 `notifiedAt`）；「开发」节 `bun test` 示例数由 190 更正为 214。`package.json` 的 `description`（四工具定位）与 `keywords` 复核后与现役能力一致，未改。
- **合并项（外派禁弹窗提示 + 跨 Bot 显式回执去向规则 + 文档）**：`TERMINAL_MARK_INSTRUCTION` 开头新增「严禁调用任何向用户弹出交互卡片或等待输入的工具」一句，并在「这一行只写标记本身」前补「若需拍板，在正文写明理由与选项，末行打 [NEEDS USER]」；`test/core.test.ts:329` 与 `test/plugin.test.ts:134` 两份 `R1_INSTRUCTION` 副本同步，`index.js:22` 重建后逐字一致。规则层并入 `AGENTS.md:23`／`:27` 两条现有条目（只写能力位，不钉工具名，不新增硬判据条目），工具名与参数名落工作区文档 `docs/ops-message-bot-reply-to-and-no-popup.md`（不在本包内）；`README.md`「派完自动回执」节补「提示词层提醒、非硬拦截，模型可以不遵守」。

## 0.11.1 · 2026-11-16

**文档补正：README 的 `workspace` 落位说明与 `preset` 缺省兜底说明与实现对齐；README 行尾恢复 LF**

- **成因**：0.11.0 把 `resolvePlacement` 的 `workspace` 分支由 `{ workspaceId: id }` 收敛为 `{ cwd: found.path }`、新增 `preset` 缺省兜底 `standard`（均为行为变更），README 仍按旧实现写「会话挂在那个工作区下，会出现在用户的对应项目里」、`preset` 行未提缺省兜底。0.11.0 的 CHANGELOG 已把两处列为已知遗留；2026-11-15 外部用户 `Cppbq` 在 `Gaudi-XIX/dsbot-session-create#1` 报告落位漂移同一现象（新会话不进工作区分组、`~/.dsh/storages/workspace.json` 的 `sessionIds` 不变），该 issue 已回复并关闭。另：补正落位说明的提交 `2d0882d` 把 `README.md` 行尾由 LF 误翻为 CRLF（279 行全量 CR），本单一并恢复。
- **改动**：① `README.md:51` 的 `workspace` 一条改为「会话使用目标工作区路径进行解析（按工作区标识），解析后与 folder 一样创建未分组（二等）会话，不加入任何 DSH 工作区项目列表」（`2d0882d`）；② `README.md:43` 的 `preset` 行补「不传时兜底 `standard`（`src/core.ts:620`）」；③ `README.md` 行尾 CRLF→LF 恢复（与仓库其余文件一致；本仓无 `.gitattributes`、无 autocrlf 设置）。仅文档，无源码、无行为改动。
- **边界**：`src/` 与 `index.js` 逐字未动（重建后 `index.js` sha256 `2359443ea977486ea64570aed2a5137da80b7c38a6e66f5254d5acc1f1717c5b`，与 0.11.0 一致，CR 计数 0）；`package.json` 只改 `version`。
- **测试实测读数**（2026-11-16 东八区，本地独立复跑）：`bun test` = 212 pass / 0 fail / 766 expect() calls / 212 tests across 5 files [502.00ms，退出码 0]；`bun run build`（bun 1.3.13）重建 `index.js` 与 0.11.0 逐字一致；`npm pack --dry-run` 载荷 5 文件（`CHANGELOG.md`/`README.md`/`index.js`/`package.json`/`cordis.patch.yml`）；本文件自身在包内，体积与 shasum 随内容变化，以发布前实跑读数为准。
- **已知遗留（本单未改）**：`test/core.test.ts:380`（仍写 `workspaceId` 落位）与 `:496`（仍写 create 不带 `agentPreset`）两条测试名仍写旧行为；`:401` 那条描述的是报错路径，与现行行为不冲突。三条断言均已对齐。

## 0.11.0 · 2026-11-15

**行为变更：不传 `preset` 时兜底 `standard`；`workspace` 落位由 `workspaceId` 收敛为物理路径 `cwd`，新会话一律进未分组**

- **成因**：两处都来自 2026-11-15 pocket client 收口。① 宿主全局默认预设 `ops-ptc` 拦截直接工具调用并强制 `run_code`，而 `dsh-agy-cli` 只暴露直接工具、没注册 `run_code`；调用方不显式传 `preset` 时 `create` 不带 `agentPreset`，子会话继承全局默认后工具塌缩死锁。兜底 `standard` 是根治，不是绕开。② `resolvePlacement` 的 `workspace` 分支原返回 `{ workspaceId: id }`，会话挂进对应 DSH 工作区、出现在用户项目里，主会话列表膨胀并触发 Pocket 预读；收敛成 `cwd` 后新会话全落未分组。
- **改动**：`src/core.ts:617` 新增 `const effectivePreset = preset ?? 'standard'`，`src/core.ts:645` 改为 `controller.create?.({ ...placement, agentPreset: effectivePreset })`；台账 `preset` 字段同步为「未显式传且兜底为 standard 时不写」。`src/core.ts:355-378` 的 `resolvePlacement` 在 workspace 分支改取 `found.path` 为 `targetPath`、校验其为非空 `string`，返回 `{ placement: { cwd: targetPath }, text: ... }`，彻底剥离 `workspaceId`；找不到、或命中项没给 path，仍抛 `workspace-unknown`。测试侧：`test/core.test.ts` 落位断言由 `workspaceId` 改为 `cwd` + `not.toHaveProperty('workspaceId')`，缺省派单断言 `agentPreset: 'standard'`；`fakeCtx` 的 `workspaceRegistry.get` / `resolveByPath` mock 补齐 `path`；`test/notify.test.ts`、`test/plugin.test.ts`、`test/read.test.ts` 的 workspace mock 与断言同步（1958bbc / e7e3462 / 06d0d31 / 163f74a）。`index.js` 是生成产物，重建后与源码一致。
- **边界**：模型钉死、权限档、回执门一~门四、终态标记、`return_to`、`session_message`、autoresume、台账追加式读写一律不动。**已知遗留（本单未改，发版定稿已如实标注）**：`README.md:49-54`「两者的区别」仍按 `workspaceId` 落位描述，`README.md:21` 仍写 `create({ cwd | workspaceId })`，`README.md:43` 的 `preset` 行未提缺省兜底；`test/core.test.ts:380`、`:401`、`:496` 三条测试名仍写旧行为，断言已对齐。这些属实现方文档与命名同步，不在发版单内。
- **测试实测读数**（2026-11-15 东八区，本地独立复跑）：`bun test` = 212 pass / 0 fail / 766 expect() calls / 212 tests across 5 files [526.00ms；改动后复跑 539.00ms，两次 TEST_EXIT=0]；`bun run build`（bun 1.3.13 bf2e2cec）重建 `index.js` 74.31 KB，sha256 `2359443ea977486ea64570aed2a5137da80b7c38a6e66f5254d5acc1f1717c5b`，与 HEAD 逐字一致、CR 计数 0；`npm pack --dry-run` 载荷 5 文件，无本机绝对路径与凭据。本包没有 `typecheck` 脚本、本机 PATH 无 `tsc`，未做静态类型检查，以 build + 全量测试替代。**未验**：真机端到端（宿主重启装载 0.11.0 后新派一单，验「未分组落位 + standard 兜底生效」）按红线不重启宿主，留作装载后首验。

**发布口径**：npm registry 此前最新为 0.6.0（2026-11-03）；本文件 0.7.0–0.10.1 六条都是本地条目、从未推到 npm。0.11.0 是 0.6.0 之后首个 npm 版本，一次带出这期间的全部代码改动。版本号按本仓库惯例升 minor（行为变更），没有选 patch 0.10.2。

## 0.10.1 · 2026-11-11

**修复：被派会话跑完写出结论、派活窗口却静默收不到回执（终态标记要求没送到被派会话）**

- **成因**：「最终答复必须写终态标记」这条契约只写在派活人可见的 `CREATE_DESCRIPTION` 里，`create_session` 投递时原样投 prompt，被派会话看不到工具说明；派活人的 prompt 没转述时它根本不知道要写标记，门四按设计压下回执。另有一个独立失效面：prompt 已写明要求、模型却把标记写在正文首行，门四只认最后一个非空行。
- **改动**：新增导出常量 `TERMINAL_MARK_INSTRUCTION` 与纯函数 `withTerminalMarkInstruction(prompt)`，投递文本改为「原 prompt 逐字作前缀 + `\n\n---\n` + 要求段」。要求段逐字点明门四口径（最后一个非空行、只写标记本身、正文开头或段落中间写不算）；`src/index.ts:52` 的工具说明补一句「插件会自动追加，派活人不必重复」。台账 `promptHead` 仍取原 prompt，`DispatchRecord` 不加字段。
- **边界**：门一~门四、`QUIET_WINDOW_MS`、`TERMINAL_MARKS`/`terminalMarkOf`、回执载荷、`return_to`、`session_message`、autoresume 一律不动；要求段只是文案层缓解，模型是否照做不在插件保证范围内。规则层（`ops-dispatch.md`、`AGENTS.md`、技能正文）未改。
- **未验**：真机端到端需宿主重启装载 0.10.1 后新派一单验「末行恰一个标记 → 回执到达 + 台账写 `notifiedAt`」；本单按红线不重启宿主，留作实现后首验。离线替代判据（投递文本逐字、`terminalMarkOf` 命中形状、`bun test` 全绿）已过。

## 0.10.0 · 2026-11-10

**减摩大版本：跨 Bot 直投回执 (return_to)、解除 idle 拦截支持继续原调研会话、回执透传完整末轮结论**

- **`create_session` 新增 `return_to` 参数**：支持由路由派单时直接指定将完成回执投递给下游 Bot（如 `return_to: "设计"` 或 `"design"`）。插件自动从 `state.json` 解析目标 Bot 活跃会话并在台账绑定 `dispatcherSessionId`，回执直投下游 Bot，消除路由二次中转损耗。
- **`session_message` 解除已完成会话的 `session-idle` 硬拦截**：当会话处于 `idle` 时，直接采用 `mode: "queue"` 追加新问题继续运行，支持多轮深入调研与连续追问，无缝继承上下文，无需强制重开新会话。
- **回执载荷透传完整结论**：废除仅保留单行首句并拼接 `read_session_transcript 取全文` 的残废回执，回执正文直接包含末轮最终答复内容（适度设置超长保护），派单方拿到回执即可直接闭环，无需二次翻查转写。

## 0.9.0 — 2026-11-06

**不兼容变更：停下的会话不再一律拒投，按末尾标记 + 台账在途分流**

- **`session_message` 对宿主直报 `idle` 的会话改成按条件续投**。三个条件同时成立才放行：① 末尾最后一条 assistant 文本里没有终态标记（`[DISPATCH DONE]` / `[NEEDS USER]` / `[DISPATCH BLOCKED]`，只认最后一个非空行开头）；② 派单台账里这条是本插件派出且还在途——`dispatchedAt` 有值、`notifiedAt` 还没写、台账读得出；③ 末条文本读得出来（`controller.page` 可用、seq 有限、page 不抛错、找得到 assistant message）。全成立 → `controller.prompt(mode: 'queue')` 把调用方原话排回这条会话接着做，不另开会话、不重灌上下文，结果与 `unreported` 一样标 `targetState: 'unreported'`。任一不成立 → 照旧抛 `session-idle` 并指向 `create_session`。动机：宿主重启掐断在途会话后，重开一支要把整段历史重灌一遍；末尾没终态标记说明这一轮是被动停下的，续投才不浪费上下文。
- **这是对旧行为的不兼容变更**：0.8.1 里 `idle` 一律 `session-idle`，调用方若靠「抛错」判断会话收口，现在末尾无标记且在途的 `idle` 会改成成功投递。有终态标记仍拒投，2026-11-01 那单事故（同一会话被补 16 轮裁决、历史涨到约 76 万 token）的防线不变。
- `running` 仍走 `mode: 'steer'`；宿主没报状态仍照投并标 `unreported`；`session-unknown` 仍拒投。`formatMessage` 的回执文案未改，续投成功时它仍只说「宿主已收下」，不冒充会话已经看过。
- **实现边界**：`lastAssistantText` 从 `installDispatchNotify` 闭包里提到模块级、与 `deliver` 共用同一份，函数体与五重 fail-closed 语义原样不动；`DispatchRecord` 没加字段；没加「只放行一次」的一次性戳；`notifiedAt` 语义没动；`deliver` 门四语义、`TERMINAL_MARKS`、`terminalMarkOf`、`blockText`、`SessionPage` 全未动。
- `MESSAGE_DESCRIPTION`（工具说明）与 `package.json` 的 description 同步改成新口径；`src/index.ts` 的 `session_message` 注册段未动。
- **尚未验证**：真机端到端（宿主重启后对在途 `idle` 会话发一条「继续」、确认续投成功且回执不断链）属实现后首验，本单未做，须重启装载后单独验。

## 0.8.1 — 2026-11-06

**行为变更：回执改传指针；终态标记只认正文末尾**

- **回执第二段由「最终答复全文（上限 2000 字符）」改为「一行结论 + 指针」**：结论取最终答复里第一个有内容的行，去掉行首 markdown 标记（`#`、`-`、`>`、`|` 等）与多余空白，截到 `CONCLUSION_LINE_CLIP`（200 字符）以内；同一行末尾附 `session <id> · read_session_transcript 取全文`。动机：0.8.0 的做法每次派单最多往派活人上下文里塞 2000 字符，省不下来。首行格式、两段结构、投递条件全部不变；第二段不会退回「只有首行」——结论行取不到时退回标记本身加指针。`[conclusion cut; N characters in all]` 提示随整段搬运一起删除。
- **终态标记判定由「全文子串扫描」改为「只认正文末尾」**：按行切后从后往前取最后一个非空行（trim 后），该行必须恰好以标记开头且标记之后只剩空白或行尾标点（`.。!！?？,，;；:：`）。正文中间引用的标记不再触发——实测样本 `session-126369fb-7b6e-47f5-a75b-fa607bc16578` 的末条正文只是引用了一句「末行恰一个 `[DISPATCH DONE]`」，旧实现据此误判为已结束。判定输入仍是不经 `clipText` 的末条 assistant 原始文本。

## 0.8.0 — 2026-11-06

**行为变更：回执带上结论**

- **回执正文由一行改为两段**：首行仍是 `[Dispatch receipt · <title>] <mark> · session <sessionId> · ended <stamp> (turn N, reason: X)`，其后换行接上**被派会话最终答复的原文**。修的是「被派会话写了终态标记、结论却到不了派活方，派活方只能自己去盘上找报告」——判定用的那条文本本来就已经读在手里，此前读完就丢。
- **首行永远原样、不参与截断**：终态标记就在首行，所以第二段再长也切不掉标记。标记判定读的仍是不经 `clipText` 的原始事件文本，未变（`clipText` 会把超长答复末尾的标记切掉，是这套判定的头号陷阱）。
- **第二段上限 `CONCLUSION_CLIP`（与 `MESSAGE_CLIP` 同值，2000 字符）**：超长只截第二段，并补一行 `[conclusion cut; N characters in all]`。取这个值是推出来的、不是顺手复用——`read_session_transcript` 对每条消息同样按 `MESSAGE_CLIP` 截，带满 2000 字符就已经覆盖了任何工具调用能取回这条消息的上限。实测三支真实审查会话的最终答复为 1543 / 1854 / 1961 字符，都不触发截断。
- **投递条件一条没动**：门一（只认正常收尾）、门二（宿主复核 `idle`）、门三（自己派的活还在跑就不算收口）、120 秒静默窗口、标记判定与 `queue` 投递方式全部照旧。
- **投递面没变**：回执仍只投给台账里的 `dispatcherSessionId`（派遣者）那一侧。插件够不着派遣者的上游——它只拿得到调用方会话 id，而「这一回合的答复自动回流给发消息的 Bot」是宿主对 `[Message from …]` 类回合的行为。结论送到派遣者之后怎么转给最初的请求方，由宿主的回合路由决定，不在本插件内。

## 0.7.0 — 2026-11-05

**三处不向后兼容的行为变更（多会话并发缺陷）**

- `read_session_transcript` 的 `sessionId` 改为**必填**：不给或给空直接报 `no-session`（`give a session id: sessionId is required and cannot be omitted.`），不再「不给就取台账里最近一条」。理由：多条派活线并存时，缺省读到的可能是别人的单，读回结论会张冠李戴。
- `list_dispatched_sessions` **默认只列本调用方自己派的单子**：拿 `exec` 里的会话 id 与台账的 `dispatcherSessionId` 比对；要看全量传 `all: true`，取不到调用方上下文时不过滤并在输出里写明。
- 台账的「已读/已通知」标记改为**追加式**：`markRead` / `markNotified` 不再「全量读入 → 内存改写 → 写临时文件 → rename 覆盖」，改为追加一条带新字段的同行记录，靠 `readLedger` 按 `sessionId` 后写覆盖先写合并。消除并发写覆盖与 `.tmp-` 孤儿文件。

## 0.6.0 — 2026-11-03

**行为变更**

- 完成回执改为**标记制**：投不投不再取决于「这一轮正常收尾」，而取决于被派会话**最终答复里写的终态标记**——`[DISPATCH DONE]`（整单完成）、`[NEEDS USER]`（需要人拍板）、`[DISPATCH BLOCKED]`（受阻停手）。判定只读该会话最后一条 `assistant` 消息的正文，大小写敏感；三个标记一个都没有就**不投**。读不到正文（`page` 缺失 / 抛错 / 超时 / 取不到 `seq` / 末条正文为空）同样不投，只记一行日志。
- 回执正文压成**一行**：`[Dispatch receipt · <title>] <mark> · session <sessionId> · ended <stamp> (turn N, reason: X)`。旧正文里「去读 transcript、无需回复」那整句删除——细节由派活方用 `read_session_transcript` 自取。门一（只认正常收尾）、门三（自己派的活还在跑就不算收口）与 120 秒静默窗口都不动，标记判定加在它们之后。
- `create_session` 的结果新增一行**一次性 deadline 建议值**：近 30 条有效台账样本（派送时刻与首次回执时刻都有）的派活时长 p95 × 1.2，线性插值、向上取整到分钟；样本不足 5 条时不出数，改说还差几条。提醒的建与删由派活方自己调 `schedule_create(after_seconds)` / `schedule_delete` 完成——插件只给数字，不写 `schedule.json`、不取 `ctx.schedule`、不新增任何轮询或常驻定时器。
- 残余四条（这一版不解决）：无标记/读不到正文时漏投是刻意的；插件不替派活方建提醒，且 `minimal` 预设没有 `schedule` 工具；派单成功到 `schedule_create` 成功之间宿主重启则既无回执也无提醒；提醒到期而宿主长期不重启不保证补投。

**文档**

- README「派完自动回执」一节重写：三个终态标记与「无标记不投」的表、一行正文、deadline 兜底（谁建谁删、`after_seconds`、收到终态回执即删、只响一次）与残余四条；删掉「想再降只能改协议，不在这一版里」那句现势句。
- README「尚未验证」补记：回执判定已挂到 `ctx.sessionController.page` 的真宿主返回形状上，该项仍未核。

## 0.5.0 — 2026-11-03

**行为变更**

- 完成回执的投递面收窄：把**假回执**（关停、重启掐断、报错、卡住）与**分段派工**（还在等自己派出去的活）挡掉，其余照旧投。
  - 实测残留（本机台账 126 单回溯）：旧口径 160 条回执 → 新口径 154 条（−3.75%，门三实际拦下 0 条）；120 单仍会收到至少一条，11 单会收到多条，最多的一单 11 条。`turn/end` 面看不出「这一单」的边界，要再降得改派单协议，不在这一版。
  - 只有正常收尾（`turn/end.reason.kind === 'completed'`）才进静默窗口；`aborted`（关停/叫停）、`interrupted`（重启掐断）、`error`、`blocked`、`max-tokens` 与认不出的取值都不投（`COMPLETED_REASON`）。取值来自 2026-11-03 全扫本机会话日志（1,740 份文件、7,851 条 `turn/end`）的统计。
  - 目标会话自己派出去的活还在跑时不投——那是分段派工，不是整单完成（`firstBusyChild`，按台账的派送链＋宿主实时状态判定）。
  - 回执正文第二句改成「正常收尾、自己派的活都停了」的写法，不再一律说「went quiet」。
- 已知边界：自己没派人、也没出错，只是这一轮干完了停下，与「整单完成」在事件面上同形，仍会投一条；由派活方按纪律决定要不要理它。

**文档**

- README「派完自动回执」一节重写。

## 0.4.0 — 2026-11-03

**行为变更**

- `permission` 的缺省档改为**一律 `danger-full-access`**：不传 `permission` 时不再现场探测宿主有没有 `auto` 档，也不再替调用方选 `auto`；结果里带 `permissionNote` 说明「`permission` 没给，开在全权限」。理由：`auto` 档下宿主 auto-review 审查每一次工具调用，而派出去的会话无人值守——审查器没按约定给出判决时，宿主直接按拒绝处理、不重试也不降级，会话卡在原地。
- 显式 `permission: 'auto'` 的行为不变：宿主名单明确没有就整单失败、不建会话（`host-missing`）；名单读不到照旧下发；下发成功后仍紧跟一步把审批策略压成 `never`。

**文档**

- README 与 `create_session` 的工具描述同步：缺省档改为全权限，原来的「三态判定」表删除。

## 0.3.0 — 2026-11-02

**行为变更**

- 启动自检的落点不再写死：改为运行时算 `DSH_AUTORESUME_STATE_DIR` > `<DSH_HOME>/bot/session-create`（`DSH_HOME` 缺省 `~/.dsh`），与派送台账同一目录。用 0.2.0 及更早版本、靠文件路径接过指针的，要跟着换落点，或设 `DSH_AUTORESUME_STATE_DIR` 指回原处；旧位置的指针不会被读，也不会被删。

**清理**

- 公开包与公开仓库里不再有写死的本机路径：源码与测试注释里的盘符路径、本机目录名全部改成描述或删掉；`tsconfig.json` 的 `typeRoots` 去掉了指向本机另一个项目的那一项。
- 新增守卫用例：扫 `src/` 下全部 `.ts`（不递归子目录），命中盘符形式的路径就判红——对应「以后不要再硬编码本机路径」这条长期要求。
- 补齐 `selectModel` 调用的类型标注：此前 `tsc --noEmit` 报 2 个错，现在 0 个；运行行为不变。

**文档**

- README 同步：启动自检的落点与 env 覆盖、类型检查怎么做、已验证的实测数字。

## 0.2.0 — 2026-11-02（已发布到 npm）

**两处不向后兼容的行为变更**

- `session_message` 从「排队投递」（`mode: 'queue'`，落在当前轮之后）改为**插队投放**（`mode: 'steer'`，插进正在跑的那一轮，下一步就读到）。
- `session_message` **拒投已经停下的会话**：宿主直报目标 `idle` 时报错 `session-idle`，什么都不发，指向 `create_session`。理由：不同轮次的活堆在同一条会话上，把历史推到 76 万 token，第二天换了更小窗口的模型就再也放不下。
- 权限档缺省从「吃宿主默认」改为「现场问宿主：有 `auto` 且能压审批策略就用 `auto`，否则退回全权限并说明」。

**新增**

- `create_session` 新增 `model` 参数，写法 `provider/model`。不写就钉死到**派活那个 Bot 自己正在用的模型**；读不到派活人的模型就整单不建（`dispatcher-model-unknown`）；写法不对也整单不建（`model-invalid`）。任何情况下都不写死模型名做兜底。
- `auto` 档在建会话后把审批策略写成 `never`（`session.append('approval/policy')`），让 reviewer 的 deny 直接终结为拒绝而不是弹一个没人应答的窗；这一步失败就归档会话并整单失败。
- 显式传 `read-only` / `workspace-write` 会被改写成 `danger-full-access`，并在结果里标出原值（`permissionOverriddenFrom`）；要放行只读探针设 `DSBOT_ALLOW_RESTRICTIVE_PERMISSION=1`。
- 台账新增字段：`preset`、`permission`、`permissionOverriddenFrom`、`approvalPolicy`；建了会话之后在权限档这一步失败的单会补写一行 `failed`（提示词投递失败不写台账，只归档并报 `prompt-failed`）。
- 结果新增 `permissionNote` / `modelNote`：任何降级或没按预期生效的保护都如实写出来。
- `session_message` 结果新增 `targetState`（`running` / `unreported`）。

**文档**

- README 重写到与当前代码一致：补上宿主启动自检、模型钉死、权限档三态判定，并订正 `session_message` 旧的「排队投递」说法；新增「已验证 / 尚未验证」一节。

## 0.1.1 — 2026-10-30

- 包名与目录改名：`dsh-session-create` → `dsbot-session-create`。
- README 补上 `session_message` 与「已在真实宿主加载」的说明。

## 0.1.0 — 2026-10-28

- 四个工具：`create_session`、`session_message`、`read_session_transcript`、`list_dispatched_sessions`。
- 派送台账、失败留痕与 fail-closed 报错（位置不成立就不建会话）。
- 派完自动回执：目标会话安静满 120 秒且宿主复核为 idle 时，把短回执投回派活人。
- 宿主启动自检投递：读接手指针唤醒指定会话，三次尝试（6s / 12s / 20s）、失败留盘、幂等只看 `written_at`。