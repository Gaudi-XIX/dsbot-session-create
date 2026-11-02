# 变更记录

按提交日期记。发布到 npm 的版本号以本文件与 `package.json` 一致。

## 0.2.0 — 2026-11-02（本地已提交，尚未发布）

**两处不向后兼容的行为变更**

- `session_message` 从「排队投递」（`mode: 'queue'`，落在当前轮之后）改为**插队投放**（`mode: 'steer'`，插进正在跑的那一轮，下一步就读到）。
- `session_message` **拒投已经停下的会话**：宿主直报目标 `idle` 时报错 `session-idle`，什么都不发，指向 `create_session`。理由：不同轮次的活堆在同一条会话上，把历史推到 76 万 token，第二天换了更小窗口的模型就再也放不下。
- 权限档缺省从「吃宿主默认」改为「现场问宿主：有 `auto` 且能压审批策略就用 `auto`，否则退回全权限并说明」。

**新增**

- `create_session` 新增 `model` 参数，写法 `provider/model`。不写就钉死到**派活那个 Bot 自己正在用的模型**；读不到派活人的模型就整单不建（`dispatcher-model-unknown`）；写法不对也整单不建（`model-invalid`）。任何情况下都不写死模型名做兜底。
- `auto` 档在建会话后把审批策略写成 `never`（`session.append('approval/policy')`），让 reviewer 的 deny 直接终结为拒绝而不是弹一个没人应答的窗；这一步失败就归档会话并整单失败。
- 显式传 `read-only` / `workspace-write` 会被改写成 `danger-full-access`，并在结果里标出原值（`permissionOverriddenFrom`）；要放行只读探针设 `DSBOT_ALLOW_RESTRICTIVE_PERMISSION=1`。
- 台账新增字段：`preset`、`permission`、`permissionOverriddenFrom`、`approvalPolicy`；建了会话之后失败的单也会留痕（`failed`）。
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