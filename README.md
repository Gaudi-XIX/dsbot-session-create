# dsbot-session-create

给 DSH 加四个工具：

- **`create_session`** —— 在指定的 DSH 工作区、或任意一个已存在的文件夹里开一个新会话，并把一段提示词投进去。开之前先把**模型**和**权限档**定下来。
- **`session_message`** —— 给一个**还在跑**的会话插一条消息（插队投放，它下一步就读到）。
- **`read_session_transcript`** —— 按会话 id 把它说过的话和当前状态读回来。
- **`list_dispatched_sessions`** —— 看这个插件派过哪些会话、各自此刻什么状态。

它是一个 DSH 插件（dsh-plugin），宿主半边，没有界面。

三条与普通「开个会话」不同的硬规则，先看这里：

1. **派出去的会话不落到宿主的全局默认模型上**。它钉死到派活那个 Bot 自己正在用的模型；读不到派活人的模型就**不建这一单**。
2. **缺省权限档是全权限**。不传 `permission` 时一律开在 `danger-full-access`，并把这一条写进结果；要 `auto` 就显式传。
3. **补话只服务还在跑的会话**。目标会话已经停下，就拒投并让你新开一个，不往历史里一层一层堆活。

## 为什么需要它

DS Bot 的 Chief 能把活派给别的 Bot（`message_bot`），但派不进「某个项目的那个会话」。
宿主本身早就有这个能力（`ctx.sessionController.create({ cwd | workspaceId })`），只是没有对外开放成工具。

这个插件就是那层薄壳：**把宿主已有的原语开成工具**。
参考实现是 DS Bot 自己的 `src/host/roster.js`（帮 Bot 建会话时用的同一批调用）。

## 工具

```
create_session(title, prompt, workspace? | folder?, preset?, permission?, model?)
session_message(sessionId, message)
read_session_transcript(sessionId, last?)
list_dispatched_sessions(limit?, all?)
```

### `create_session`

| 参数 | 必填 | 说明 |
| --- | --- | --- |
| `title` | 是 | 新会话的名字，显示在会话列表里 |
| `prompt` | 是 | 投进新会话的那段话（排队投放，`mode: 'queue'`） |
| `workspace` | 二选一 | 工作区 id，或它的完整文件夹路径 |
| `folder` | 二选一 | 任意一个存在的文件夹的完整路径 |
| `preset` | 否 | agent 预设（`standard` / `minimal` / `ptc` / `creator`），建会话时写进 header，开跑后不能换；名字错就整单不建 |
| `permission` | 否 | 权限档，见下面「权限档」 |
| `model` | 否 | 写成 `provider/model`；不写就与派活的那个 Bot 一致 |

`workspace` 和 `folder` **必须给且只能给一个**。

两者的区别：

- `workspace` —— 会话挂在那个 DSH 工作区下，会出现在用户的对应项目里。
- `folder` —— 会话按 `cwd` 创建，**不加入任何 DSH 工作区**，用户的项目列表保持原样。

两者是同一套宿主原语的两种落位方式，没有别的差别。

#### 模型（fail-closed）

宿主 `sessionController.create` **不转传 model**，所以不钉就是「宿主的全局默认模型」；2026-11-01 那个默认一度是按量付费的模型，派出去的会话因此替用户烧过真钱。所以：

- 不写 `model` 时，取**派活那个 Bot 自己会话正在用的模型**（`agent.session.requestHeader().config` 的 provider / model / reasoningEffort）。
- **不写任何模型名做兜底**：写死一个名字，provider 或组一改名，这条绑定就静默失效。
- 显式写 `model` 必须是 `provider/model`——按第一个斜杠切一刀、两边都要有字；`provider` 空或 `model` 空就整单失败（`model-invalid`），model 本身允许再带斜杠（`b/c`）。
- 派活人的模型**读不到就不建这一单**（`dispatcher-model-unknown`）。宁可失败，也不留一条会落到全局默认模型上的会话。
- 建会话之后用 `sessionController.selectModel` 钉死。这一步失败**不**中断派送，但结果里带一句 `modelNote`，明说「没钉上、可能落到宿主默认、花额度之前先查它的模型」。

#### 权限档

档名由宿主判定（`/permission` 的合法值会随宿主升级漂移），本插件不硬编码白名单，只做三件事：

- **显式传 `read-only` / `workspace-write` 会被改写成 `danger-full-access`**，并在结果里如实标出 `permissionOverriddenFrom`。理由：这两档带 `approval: ask`，派单会话无人应答就整轮卡死，而宿主没有「给已存在会话提权」的入口。要放行只读探针，在宿主环境里设 `DSBOT_ALLOW_RESTRICTIVE_PERMISSION=1`（值必须严格等于 `1`）。
- **没传 `permission` 时一律开在 `danger-full-access`**，并在结果里带 `permissionNote` 说明。理由：`auto` 档下宿主 auto-review 审查每一次工具调用，而派出去的会话无人值守——审查器没按约定给出判决时，宿主直接按拒绝处理、不重试也不降级，会话就卡在原地。要 `auto` 就**显式传**。
- **没有 `commands.execute` 时**设不了档：保持不传，吃宿主默认（本机默认就是全权限），并在结果里说明。
- **显式要 `auto` 时**：宿主名单明确没有就整单失败、不建会话（`host-missing`）；名单读不到就照旧下发，让宿主的 `/permission` 自己去判认不认这个名字。
- `auto` 档的第二步是把审批策略写成 `never`：`auto` 自带 `ask`，无人值守时 reviewer 判 deny 会变成整晚卡死。这一步走 `session.append('approval/policy', { policy: 'never' })`，不调 `ApprovalService.setPolicy`（后者会往会话里注入一条假消息）；写不进去就**归档这个会话并整单失败**——让会话带着 `ask` 活下去，等于埋一颗整晚卡死的雷。
- 有一处宿主机制产物要知道：`/permission auto` 那一步自己会写一条 `ask`，并往会话里注入一句「changed from "never" to "ask"」的 user 消息；本插件紧跟其后写 `never`，最终生效的是 `never`，但读 transcript 时会看到那条消息。

### 派送台账

每次 `create_session` 成功，都会往**派送台账**追加一行：

```
$DSH_HOME/bot/session-create/dispatched-sessions.jsonl      # 可用 DSH_SESSION_CREATE_LEDGER 覆盖
```

每行记住：会话 id、标题、落位、提示词开头、派送时刻，以及这一单实际下发的 `preset` / `permission` / `permissionOverriddenFrom` / `approvalPolicy`，和**派活人的会话 id**（回执按它投回去）。建了会话、但**权限档**这一步失败的单会补写一行 `failed`（`src/core.ts:679`），否则事后谁都在会话列表里找不到那个空会话；提示词投递失败走另一条路——归档会话并报 `prompt-failed`，不写台账。

台账写失败**不会**让整次派送算失败（会话已经建出来了），但结果里会带 `ledgerError`，并写明「自己手动记下这个 session id」。

读回回执与「已读/已通知」标记**也是追加**：不重写整份台账，只在末尾再追加一条带新字段的同行记录，读取时按 `sessionId` 后写的覆盖先写的（`readLedger`）。并发的两条派活线因此不会互相覆盖，也不会留下 `.tmp-` 孤儿文件。

落点为什么在 `bot/` 下：这份账是 **Bot ↔ 人的交接记录**，属于 DS Bot 自己的数据，所以跟在 DS Bot 的 home（`<DSH_HOME>/bot`）里。若 ds-bot 的 home 被它自己的 profile 配置改到别处，用 `DSH_SESSION_CREATE_LEDGER` 对齐。

### `session_message`

给一个**已经存在、且还在跑**的会话插一条消息，不新建会话：

| 参数 | 必填 | 说明 |
| --- | --- | --- |
| `sessionId` | 是 | 目标会话的 id（`create_session` 或 `list_dispatched_sessions` 给的） |
| `message` | 是 | 插进去的那段话 |

- 走 `controller.prompt(mode: 'steer')`（宿主 `agent.steer`）：**插进正在跑的那一轮**，会话下一步就读到，不等这一轮结束。
- 目标会话的 turn 已经结束（宿主直报 `idle`）时**拒投**（`session-idle`），并指向 `create_session`。判据只用宿主直给的状态，不替调用方判断「这条消息算新任务还是纠偏」——那是语义判断。这条是 2026-11-01 那单事故的防线：同一条会话被补了 16 轮裁决，历史涨到约 76 万 token，第二天宿主把它切到 512,000 窗口的模型后立刻放不下。
- 宿主没报状态时按「还在跑」处理，结果里如实标 `targetState: unreported`。
- 只说「已插进正在跑的那一轮」，不说「它看过了」——后者只有读回才能证明。
- 单次投递超时 10 秒（`MESSAGE_TIMEOUT_MS`）。

### `read_session_transcript`

按 id 取回一个会话说了什么、现在什么状态（最新若干条消息 + 当前这一轮结束没有）。`sessionId` **必填**：不给或给空就报 `no-session`，什么都不读。台账里记着好几单，猜「最近那一单」会读错别人的活。

`last` 给取回多少条（1..200，默认 40），更早的用更大的值再读。历史读回超时 20 秒（`HISTORY_TIMEOUT_MS`）。

### `list_dispatched_sessions`

倒序列出台账里的派送，每条带**此刻**的状态：还在跑 / 上一轮已结束 / 还没起跑（`not started`）/ 读失败。用来挑「哪些可以收了」。

**默认只列本调用方自己派的单子**：调用方会话 id 从 `exec` 取，与台账里的 `dispatcherSessionId` 比对。要看全部就传 `all: true`；取不到调用方上下文（手工调用、别的宿主形态）时不过滤，输出里会写开。

### 状态是怎么来的

会话「跑完没有」有两条来源，插件**优先问宿主**，拿不到才从会话自己的事件推：

- 宿主直给（`agent.status` 是 `running` / `idle`）→ 输出写 `the harness reports this Session as running`；
- 事件推断（只有 `turn/start` 没有 `turn/end`）→ 输出写 `read from the Session's own events`。

两种来源的措辞**故意不同**：推断不许冒充宿主结论。

读回走宿主自带的 `ctx.sessionController.page({ address, throughSeq, maxMessages }, signal)`，参数形状逐字照抄 DS Bot 自己的三处生产调用（`src/host/parts.js:1287`、`chat-index.js:58`、`usage.js:351`）——不自己造一套读事件的机制。宿主内置的 `session_event_read` / `session_search` 工具**对普通会话不可用**（返回 `No session matched "…"`），故不走。

### 派完自动回执

派送时把派活人的会话 id 记进台账。目标会话**正常收尾**（`turn/end.reason.kind === 'completed'`）、安静满 **120 秒**（`QUIET_WINDOW_MS`）、宿主复核为 `idle`、**它自己派出去的活都已经停下来**，并且**它的最终答复里写了终态标记**，插件才用 `controller.prompt(mode: 'queue')` 投一条回执回派活人（`src/core.ts` 的 `createDispatchNotifier`，`src/index.ts` 的 `installDispatchNotify` 挂到 ctx 上——没人调用工具时也要有东西替我们盯着）。

投不投由**派活方在最终答复里写的标记**决定，插件只认标记：

| 最终答复里的标记 | 回执 | 含义 |
| --- | --- | --- |
| `[DISPATCH DONE]` | 投 | 整单完成 |
| `[NEEDS USER]` | 投 | 需要人拍板 |
| `[DISPATCH BLOCKED]` | 投 | 受阻停手，要人来救 |
| 三个都没有 | **不投** | 中间收工，还在等自己派的活 |

判定只读**该会话最后一条 `assistant` 消息的正文**，不看整篇 transcript；大小写敏感，全角括号或错拼一律不算标记。而且只认**正文末尾**：从后往前第一个非空行必须恰好是标记（允许该行前后有空白、行尾少量标点），正文中间引用的标记不算——`session-126369fb-7b6e-47f5-a75b-fa607bc16578` 那单的末条正文只是引用了「末行恰一个 `[DISPATCH DONE]`」，旧的全篇子串扫描据此误判成已结束。

回执正文分两段：首行说清「哪一单」，第二段只有**一行结论加一个指针**——派活人一眼看到结果，要看全文再按指针自取，整篇不搬进它的上下文：

```
[Dispatch receipt · <title>] <mark> · session <sessionId> · ended <stamp> (turn N, reason: X)
<一行结论> · session <sessionId> · read_session_transcript 取全文
```

`<title>` 是派单时给的标题，`<mark>` 是命中的那个标记，`<stamp>` 是这一轮结束的时刻，括号里仍是 `turn N, reason: X`。首行**永远原样、不参与截断**。

第二段的结论行取自被派会话最终答复里**第一个有内容的行**：去掉行首 markdown 标记（`#`、`-`、`>`、`|` 等）与多余空白，截到 `CONCLUSION_LINE_CLIP`（200 字符）以内，超长时以省略号收口。全文不塞进回执（0.8.0 最多搬 2000 字符，正是这次改掉的成本项），同一行末尾的指针给出 `read_session_transcript` 的取法。结论行取不到时第二段退回标记本身加指针，**不会退化成只有首行**——派活人始终知道这一单的结果。

**投递面没变**：回执仍只投给台账里的 `dispatcherSessionId`（派遣者）那一侧。插件够不着派遣者的上游——它只拿得到调用方会话 id，而「这一回合的答复自动回流给发消息的 Bot」是宿主对 `[Message from …]` 类回合的行为。结论送到派遣者之后怎么转给最初的请求方，由宿主的回合路由决定，不在本插件内。

- **只认正常收尾**：`aborted`（关停/叫停）、`interrupted`（重启掐断）、`error`、`blocked`、`max-tokens`，以及认不出来的取值，一律不进静默窗口、一个回执都不发（`COMPLETED_REASON`，门一）。取值来自 2026-11-03 全扫本机 `<DSH_HOME>/data/sessions/**`（当日 1,740 份文件、7,851 条 `turn/end`）的统计：`completed` 6,914 / `aborted` 464 / `error` 171 / `blocked` 153 / `interrupted` 121 / `max-tokens` 29。
- **还在等自己派的活就不算收口**：台账里 `dispatcherSessionId` 指向它、宿主又报着没停的子会话，说明它是在等它们（`firstBusyChild`，门三）。等的时候不投；子会话停下、它被叫醒再跑一轮、这一轮没有在跑的子会话，才投。
- **无标记一律不投**：既包括「这一轮干完了、还在等自己派出去的活」，也包括「忘了写标记」；正文中间引用标记同样不算（只认末尾）。另外，`page` 不在宿主服务面、`page` 抛错或超时、拿不到 `seq`、末条 `assistant` 正文为空——都发声一行日志后**不投**。宁可漏一条，也不投一条假回执。

回执走 `queue` 不走 `steer`：它是给派活人的旁路通报，排到下一轮，不去打断他手头正在跑的那一轮。

#### 一次性 deadline 兜底

回执永远不来时，兜底靠**派活方自己建的一次性提醒**，插件只给数值、不碰调度系统（不写 `schedule.json`、不取 `ctx.schedule`、不新增任何常驻定时器）。

- **谁建谁删**：派活方在派单那一轮调 `schedule_create`，收到那一单的终态回执后调 `schedule_delete`。
- **数值哪来**：`create_session` 的结果里多一行 `Suggested one-shot deadline: <N> minutes`；算法是台账里**近 30 条**「派送时刻与首次回执时刻都有」的有效样本，取派活时长的 **p95 × 1.2**，线性插值后向上取整到分钟。样本不足 5 条时不出数，改说 `No one-shot deadline suggested: only <k> completed ledger records carry both timestamps (need 5).`
- **怎么建**：`schedule_create(after_seconds = N × 60)`，`after_seconds` 形态只响一次，没有周期巡检。
- **前提**：`schedule` 工具由 `standard` / `ptc` 预设挂载，`minimal` 没有——建议行里写明这一点，插件不做检测。

#### 残余四条

1. **漏投是刻意的**：末条正文读不到、或正文里没有标记，一律不投；漏一条的代价是派活方多等一次 deadline。
2. **插件不替派活方建提醒**：只给建议秒数，建和删都由派活方在会话里做；`minimal` 预设下这个工具根本不在。
3. **宿主重启的缺口**：派单成功到 `schedule_create` 成功之间宿主重启，既没有回执也没有提醒，只能由派活方按台账自查。
4. **到期不保证补投**：提醒到期而宿主长期不重启时，宿主调度器没有自动重试定时器，补投不可保证。

### 宿主启动自检（重启后自动接续）

宿主重启时在跑的 Bot 会话一并被杀，醒来后没有东西会主动说「刚重启过、盘上有接手指针」。这一段补上它（`src/autoresume.ts`，`src/index.ts:303` 的 `installAutoResume`）：

- **只认两个文件**：指针 `restart-pending.json`，已确认记录 `restart-pending.ack.json`。目录**运行时算**，不写死：`DSH_AUTORESUME_STATE_DIR` > `<DSH_HOME>/bot/session-create`（`DSH_HOME` 缺省 `~/.dsh`，与派送台账同一目录；`src/autoresume.ts` 的 `resolveAutoresumeStateDir`）。要接到别处就设那个 env，不用改代码。
- **目标只能是指针里的 `notify_session_id`**：缺失或不是字符串就跳过。不猜主会话、不遍历会话列表。
- **投三次**：间隔 6s / 12s / 20s（`src/autoresume.ts:50`，`AUTORESUME_RETRY_DELAYS_MS`；38s 是三次间隔之和，不是总超时——单次投递上限 10s）。宿主刚起来那几秒恰恰是最可能投不进去的时刻，所以单跳不够；只有 `send-failed` 才排下一次，送达、已确认、没指针、没目标都是终态。
- **幂等只看 `written_at`**：已确认记录里的 `written_at` 不严格新于指针的 `written_at` 就跳过。失败也写一份 ack，但**故意不写 `written_at`**——它只是盘上的证据，不参与幂等判断，所以下次启动照常重试。
- **只投 `prompt(mode: 'queue')`**，不建会话、不改会话状态。唤醒正文只给指针的绝对路径和固定一句「上一个宿主 pid」，让收到消息的一方自己去读盘，不抄正文。
- **关掉它**：`DSH_AUTORESUME_DISABLE=1`（在读任何文件之前就判断，连定时器都不注册）。
- **全程 fail-open**：读不到盘、JSON 坏、没有目标，都只记一行日志就安静退出；定时器 `unref`，不阻塞宿主启动也不拖住宿主退出。

## 失败时的行为（fail-closed）

位置不成立就**什么都不建**，直接报错：

| 情况 | 结果 |
| --- | --- |
| 文件夹不存在 | 报错，不建会话 |
| 工作区认不出 | 报错，**不回落**到默认工作区 |
| `workspace`/`folder` 两个都给或都不给 | 报错 |
| `preset` 名字宿主不认 | 报错，不建会话 |
| `model` 不是 `provider/model` | 报错（`model-invalid`），不建会话 |
| 派活人的模型读不到 | 报错（`dispatcher-model-unknown`），不建会话 |
| 显式要 `auto`、宿主名单里没有 | 报错（`host-missing`），不建会话 |
| 宿主缺所需服务 | 报错，附上缺了哪几个 |
| 权限档设不上 | 归档这个会话，整单报错 |
| `auto` 的审批策略写不进 | 归档这个会话，整单报错 |
| 提示词投递失败 | 归档这个会话，如实报错，不对外说成功 |
| 补话给已经停下的会话 | 拒投（`session-idle`），什么都不发 |

那张「宿主缺服务」的报错要能真的报出来，靠的是**服务不写进 `inject` 硬声明**：插件只 `inject: ['tools']`，其余服务都走 `ctx.get()` 宽容路径（`src/core.ts` 的 `resolveServices`）。写成硬 inject 的话，宿主缺服务时整棵插件树会加载失败，`preflight` 那句可读报错根本没有机会执行——用户只会看到「工具不存在」。

这里和 DS Bot 的 `roster.js` 有一处**有意不同**：它会「工作目录没了就悄悄换到团队工作区」，本插件不这么做——悄然换位置会让人以为任务落在 A 项目，实际跑在别处。

归档失败时，报错里会改成说「列表里可能还留着一条空会话」——不谎称已归档。

## 装

推荐以链路方式装进 profile：

```
# 在 profile 目录里（<DSH_HOME>/profiles/<profile>）
# 把 "dsbot-session-create": "link:<本插件目录的绝对路径>" 加进 package.json 的 dependencies
```

或直接把本目录复制进 `node_modules/`。装完 **必须重启 DSH**（重启只能由用户执行）。

`cordis.patch.yml` 负责把它挂上：

```yaml
- insert:
    - id: session-create
      name: dsbot-session-create
```

## 开发

```bash
bun run build   # src/*.ts → index.js（@deepseek-ai/dsh-tools 保持 external）
bun test        # 190 个测试、5 个文件；plugin.test.ts 测的是构建产物，跑前先 build
```

类型检查（本仓不带 `typescript` 与 `@types/node` 依赖，用现成的那份就行）：

```bash
node <某个 node_modules>/typescript/bin/tsc --noEmit -p . --typeRoots <同一个 node_modules>/@types
```

`--typeRoots` 显式指过去，是因为 `tsconfig.json` 里**没有**写任何本机路径：它只声明 `"types": ["node"]`，落在哪由你调用时决定。

## 几个必须知道的事实

- **`@deepseek-ai/dsh-tools` 不在 profile 的 `node_modules` 里**（在宿主 `app.asar` 内，加载插件时注入）。所以 `test/stubs/dsh-tools.ts` 是它的替身，`tsconfig.json` 的 `paths` 只为本机开发把它指过去——那**不是**权威类型定义，是按 DS Bot 的实际用法反推的最小形状。
- 宿主 API 的形状（`create` 返回 `{ sessionId }`、`prompt` 要 `requestId` + `mode` + `content:[{type:'text',text}]`）是从 DS Bot 的源码**读出来**的，不是从官方文档抄的。上游没有这层文档。
- **代码与文档里不许出现本机路径**（2026-11-02 用户定）：源码、测试、注释、配置一律不许写盘符路径、用户名或本机目录名。唯一例外是单元测试里验证「Windows 路径怎么处理」用的**虚构样本**（`test/read.test.ts`、`test/core.test.ts` 与 `test/autoresume.test.ts` 里那几个），它们跟这台机器的实际目录无关。默认落点由 `DSH_HOME` / `homedir()` 在运行时算，要换就加一个 env 覆盖；`test/autoresume.test.ts` 有一条用例扫 `src/` 下全部 `.ts`（不递归子目录），命中盘符形式的路径就判红。
- 启动自检的落点跟随上面的规则：换机器、换 `DSH_HOME` 都不用改代码；要把指针接到某个固定目录，设 `DSH_AUTORESUME_STATE_DIR`。
- 派出去的**提示词**走 `queue`，**补话**走 `steer`，**回执**走 `queue`——三个通道口径不同，改的时候别顺手统一。

## 已验证 / 尚未验证

**已验证（2026-11-03 实测）**

- `bun run build` 之后 `git status` 只见预期改动：`index.js` 与 `src/` 同步（69,033 B / sha256 cbc2b6c6cd7af2b61f321556007b8953a5837724d158fbf4e7f6089f823ae010）。
- `bun test`：193 pass / 0 fail / 703 次断言，5 个文件（bun 1.3.13）。
- `tsc --noEmit -p . --typeRoots <现成的 node_modules>/@types`（借一份现成的 `typescript` 与 `@types/node`，见「开发」）：0 个错误。**不带 `--typeRoots` 会报 `error TS2688: Cannot find type definition file for 'node'.` 并退出码 2**——本仓没有自己的 `node_modules`。
- 0.2.0 那份构建的**描述文本确实在真实宿主里加载过**：宿主会话的工具表里 `create_session` 带上了 `model` 参数与 `auto` 权限段（`never the host's global default`、`DSBOT_ALLOW_RESTRICTIVE_PERMISSION`），说明 profile 挂的就是本仓的 `index.js`。0.4.0、0.5.0 与 0.6.0 的改动都要重启宿主之后才生效（重启只能由用户执行）。

**尚未验证**

1. `ctx.sessionController.page` 在真宿主里是否真按 `{ records, hasMore }` 返回（参数形状抄的是 DS Bot 生产代码，不是官方文档）。**本版把回执判定挂到了这条读回通道上，这一项仍未核**——假载体全绿的测试不能证明真宿主可用。
2. `steer` 插队以后，目标会话是否真在下一步就读到（只验到「宿主受理」这一层）。
3. `auto` 档写 `approval/policy: never` 在真宿主里是否被认（单测覆盖的是「写不进去就归档并报错」这条路）。
4. 启动自检的**真重启投递**：注册、延迟序列、幂等判据都有单测，但没在真重启里收过那条唤醒消息。
5. **提示词的 30 秒超时上限**没有「真触发」用例——bun 1.3.13 的 `AbortSignal.timeout` 在进程没有其它待办定时器时不触发（宿主是 Node，不受影响）。
6. `last` 夹到 1..200、`limit` 夹到 1..20 是本插件自定的范围，宿主有没有更低的天花板未验。

## 许可

MIT