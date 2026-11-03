# 变更记录

按提交日期记。发布到 npm 的版本号以本文件与 `package.json` 一致。

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