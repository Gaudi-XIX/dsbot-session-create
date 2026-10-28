# dsh-session-create

给 DSH 加三个工具：**`create_session`** —— 在指定的工作区、或任意一个已存在的工作文件夹里开一个新会话，并把一段提示词直接投进去；**`read_session_transcript`** —— 按会话 id 把它说过的话和当前状态读回来；**`list_dispatched_sessions`** —— 看这个插件派送过哪些会话、各自此刻什么状态。

它是一个 DSH 插件（dsh-plugin），宿主半边，没有界面。

## 为什么需要它

DS Bot 的 Chief 能把活派给别的 Bot（`message_bot`），但派不到「某个项目的那个会话」里去。
宿主本身早就有这个能力（`ctx.sessionController.create({ cwd | workspaceId })`），只是没有对外开放成工具。

这个插件就是那层薄壳：**把宿主已有的原语开成工具**。
参考实现是 DS Bot 自己的 `src/host/roster.js`（帮 Bot 建会话时用的同一批调用）。

## 工具

```
create_session(title, prompt, workspace? | folder?)
read_session_transcript(sessionId?, last?)
list_dispatched_sessions(limit?)
```

### `create_session`

| 参数 | 必填 | 说明 |
| --- | --- | --- |
| `title` | 是 | 新会话的名字，显示在会话列表里 |
| `prompt` | 是 | 投进新会话的那段话（排队投递；它会不会立刻开跑见下面「尚未验证的边界」） |
| `workspace` | 二选一 | 工作区 id，或它的完整文件夹路径 |
| `folder` | 二选一 | 任意一个存在的文件夹的完整路径 |

`workspace` 和 `folder` **必须给且只能给一个**。

两者的区别：

- `workspace` —— 会话挂在那个 DSH 工作区下，会出现在用户的对应项目里。
- `folder` —— 会话按 `cwd` 创建，**不加入任何 DSH 工作区**，用户的项目列表保持原样。

两者是同一套宿主原语的两种落位方式，没有别的差别。

### 派送台账

每次 `create_session` 成功，都会往**派送台账**追加一行，记住这条会话的 id、标题、落位、提示词开头和派送时刻：

```
$DSH_HOME/bot/session-create/dispatched-sessions.jsonl      # 可用 DSH_SESSION_CREATE_LEDGER 覆盖
```

这是「派出去以后还能找回来」的凭据。台账写失败**不会**让整次派送算失败（会话已经建出来了），但结果里会带一个 `ledgerError`，并把「自己手动记下这个 session id」写进给用户看的文案。

落点为什么在 `bot/` 下：这份账是 **Bot ↔ 人的交接记录**，属于 DS Bot 自己的数据，所以跟在 DS Bot 的 home（`<DSH_HOME>/bot`，ds-bot 自己也是这条规则）里，不与它平级另立一处。若 ds-bot 的 home 被它自己的 profile 配置改到别处，用 `DSH_SESSION_CREATE_LEDGER` 对齐。

### `read_session_transcript`

按 id 取回一个会话说了什么、现在什么状态（最新若干条消息 + 当前这一轮结束没有）。**不给 `sessionId` 就取台账里最近一条派送**，所以「刚派完那单跑完没」不需要手动找 id。

`last` 给取回多少条（1..200，默认 40），更早的用更大的值再读。

### `list_dispatched_sessions`

倒序列出台账里的派送，每条带**此刻**的状态：还在跑 / 上一轮已结束 / 读失败。用来挑「哪些可以收了」。

### 状态是怎么来的

会话「跑完没有」有两条来源，插件**优先问宿主**，拿不到才从会话自己的事件推：

- 宿主直给（`agent.status` 是 `running` / `idle`）→ 输出写 `the harness reports this Session as running`；
- 事件推断（只有 `turn/start` 没有 `turn/end`）→ 输出写 `read from the Session's own events`。

两种来源的措辞**故意不同**：推断不许冒充宿主结论。

读回走的是宿主自带的 `ctx.sessionController.page({ address, throughSeq, maxMessages }, signal)`，参数形状逐字照抄 DS Bot 自己的三处生产调用（`src/host/parts.js:1287`、`chat-index.js:58`、`usage.js:351`）——不自己造一套读事件的机制。宿主内置的 `session_event_read` / `session_search` 工具**对普通会话不可用**（返回 `No session matched "…"`），故不走。


## 失败时的行为（fail-closed）

位置不成立就**什么都不建**，直接报错：

| 情况 | 结果 |
| --- | --- |
| 文件夹不存在 | 报错，不建会话 |
| 工作区认不出 | 报错，**不回落**到默认工作区 |
| 两个都给 / 都不给 | 报错 |
| 宿主缺所需服务 | 报错，附上缺了哪几个 |

那张「宿主缺服务」的报错要能真的报出来，靠的是**服务不写进 `inject` 硬声明**：插件只 `inject: ['tools']`，`sessionController` / `sessionTitle` / `workspaceRegistry` 三个都走 `ctx.get()` 宽容路径（见 `src/core.ts` 的 `resolveServices`）。写成硬 inject 的话，宿主缺服务时整棵插件树会加载失败，`preflight` 那句可读报错根本没有机会执行——用户只会看到「工具不存在」。两个第三方先例（`dsh-better-sidebar`、`dsh-prime-memory`）都只用 `ctx.get` 取这几个服务。

这里和 DS Bot 的 `roster.js` 有一处**有意不同**：它会「工作目录没了就悄悄换到团队工作区」，本插件不这么做——悄然换位置会让人以为任务落在 A 项目，实际跑在别处。

会话建好但**提示词投递失败**时，会把这个空会话归档掉，并如实报错，不会对外说成功。归档本身也失败时，报错里会改成说「列表里可能还留着一条空会话」——不谎称已归档。

## 装

本机（DSH 0.2.1-rc.3）以链路方式装进 profile：

```
# 在 profile 目录里（F:\AgentData\dsh\data\profiles\desktop）
# 把 "dsh-session-create": "link:F:\\DSBOT\\plugins\\dsh-session-create" 加进 package.json 的 dependencies
```

或直接把本目录复制进 `node_modules/`。装完 **必须重启 DSH**（重启只能由用户执行）。

`cordis.patch.yml` 负责把它挂上：

```yaml
- insert:
    - id: session-create
      name: dsh-session-create
```

## 开发

```bash
bun run build   # src/*.ts → index.js（@deepseek-ai/dsh-tools 保持 external）
bun test        # 69 个测试；plugin.test.ts 测的是构建产物，跑前先 build
```

类型检查（本机没装 tsc，借用现成的）：

```bash
node F:/AgentData/dsh-agy-cli/node_modules/typescript/bin/tsc --noEmit -p .
```

## 几个必须知道的事实

- **`@deepseek-ai/dsh-tools` 不在 profile 的 `node_modules` 里**（在宿主 `app.asar` 内，加载插件时注入；`node_modules/@deepseek-ai/**/package.json` 在本 profile 是 0 命中）。所以 `test/stubs/dsh-tools.ts` 是它的替身，`tsconfig.json` 的 `paths` 只为本机开发把它指过去 —— 那**不是**权威类型定义，是按 DS Bot 的实际用法反推的最小形状。
- 宿主 API 的形状（`create` 返回 `{ sessionId }`、`prompt` 要 `requestId` + `mode: 'queue'` + `content:[{type:'text',text}]`）是从 DS Bot 的 `src/host/roster.js`、`channel.js` **读出来**的，不是从官方文档抄的。上游没有这层文档。
- **尚未在真实宿主里加载过**：需要用户重启 DSH 才能验。在此之前，全部验证都止于「假 ctx + 构建产物」。
- 本机沙箱只允许在插件目录下写（`%TEMP%` 与 `F:\DSBOT\tmp` 都是 EPERM），所以测试的临时目录放在 `.tmp/`。

## 尚未验证的边界

以下五条**没验过**，写在这里以免被当成已知：

1. **真宿主里读回的形状**：`ctx.sessionController.page` 在真实宿主上是否真按 `{ records, hasMore }` 返回，未验（参数形状抄的是 DS Bot 生产代码，不是官方文档）。装上 + 重启后第一件要验的就是它。
2. **`mode: 'queue'` 投给一个刚建出来的空会话**是否被宿主接受，未验。
3. **提示词会不会立刻开跑**：投递只是排队，宿主何时起跑未验；因此对外文案只说「已排队」，不说「它正在干」。
4. **提示词的 30 秒超时上限**：这条路径没有「真触发」用例——测试运行器 bun 1.3.13 的 `AbortSignal.timeout` 在进程没有其它待办定时器时不触发（宿主是 Node，不受影响）。
5. **`last` 夹到 1..200、`limit` 夹到 1..20** 是本插件自定的范围，宿主有没有更低的天花板未验。

另外，能否「跑完自动把结果推给你」也**没做**：现在是**一条命令就能取回**，不是自动送达。要做自动送达得靠定时轮询或宿主事件，建议等上面第 1 条验过之后再谈。

## 许可

MIT
