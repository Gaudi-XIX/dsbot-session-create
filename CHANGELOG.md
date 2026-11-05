# 变更记录

按提交日期记。发布到 npm 的版本号以本文件与 `package.json` 一致。

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