// 核心逻辑：与宿主 ctx 解耦，用假 ctx 可直接单测（test/core.test.ts / test/read.test.ts）。
// 设计口径见 F:\DSBOT\docs\chief-session-create-capability-20261026.md §1.2 / §三 / §十一：
//   ① 位置不成立 → 不建会话、显式报错（fail-closed），不继承 ds-bot 的「悄悄换到团队工作区」回落。
//   ② 派送时把会话 ID 写进台账；事后用同一个 ID 读回该会话的转写（用户 2026-10-26 要求）。
import { randomUUID } from 'node:crypto'
import { appendFile, mkdir, readFile, rename, stat, writeFile } from 'node:fs/promises'
import { homedir } from 'node:os'
import { dirname, join } from 'node:path'

export const PROMPT_TIMEOUT_MS = 30_000
// 读历史是一次本地分页查询，比投递更快，给 20 秒足够。
export const HISTORY_TIMEOUT_MS = 20_000
// 设会话选项（preset / permission）都是本地的一次服务调用，10 秒是上限而非预期耗时。
export const SESSION_OPTION_TIMEOUT_MS = 10_000
// 往已存在的会话里补一条消息：同样是本地一次调用，10 秒是上限而非预期耗时。
export const MESSAGE_TIMEOUT_MS = 10_000
// 单条消息在工具输出里的上限：够看清结论，又不至于把一整篇文档灌进上下文。
export const MESSAGE_CLIP = 2_000
// 一次最多取多少条消息（宿主 page 的 maxMessages）。
export const MESSAGES_MAX = 200
export const MESSAGES_DEFAULT = 40

export type ResolvedAgent = {
  agent?: {
    session?: { seq?: number } & Record<string, unknown>
    /** 宿主给这个会话的状态。生产代码里出现过 'running' 与 'idle'（parts.js:1118、resume.js:372）。 */
    status?: unknown
  }
  error?: { message?: string; code?: string }
}

export type SessionPage = {
  records?: { event?: unknown }[]
  hasMore?: boolean
}

export type WorkspaceEntry = { id?: string; path?: string; title?: string }

export type HostCtx = {
  // 宽容的服务获取路径（cordis ctx.get）。本插件**不**把平台服务写进 inject 硬声明：
  // 硬 inject 会在宿主缺该服务时让整棵插件树加载失败，preflight 的可读报错就永远不会执行。
  // 依据：dsh-prime-memory/dist/workspace.js:15-17 的注释；两个第三方先例同样只用 ctx.get 取这些服务。
  get?: (name: string) => unknown
  // 宿主事件面（cordis Context.on）。完成回执的监听点：ds-bot 的三处生产用法都是
  // `ctx.on('session/event', (session, event) => …)`（resume.js:179、turns.js:366）。
  // 这个事件面是**全宿主**的 —— 插件没有 ds-bot 那道 rt.isBotSession 过滤，守门改由台账承担，
  // 见 installDispatchNotify 与 createDispatchNotifier 里的白名单那一段。
  on?: (name: string, handler: (session: unknown, event: unknown) => void) => void
  tools?: { register?: (tool: unknown) => void }
  sessionController?: {
    create?: (options: Record<string, unknown>) => Promise<{ sessionId?: string }>
    prompt?: (options: Record<string, unknown>, signal?: AbortSignal) => Promise<unknown>
    resolveAgent?: (sessionId: string) => Promise<ResolvedAgent>
    // 读回通道：ds-bot 0.2.2 有两处生产调用（parts.js:1287、chat-index.js:58），
    // 且都是不带可选链的直接调用 —— 本宿主里它存在。本插件仍按未验处理，缺了就报错。
    page?: (options: Record<string, unknown>, signal?: AbortSignal) => Promise<SessionPage | undefined>
  }
  sessionTitle?: { rename?: (session: unknown, title: string) => Promise<unknown> }
  workspaceRegistry?: {
    get?: (id: string) => WorkspaceEntry | undefined
    list?: () => WorkspaceEntry[]
    resolveByPath?: (path: string) => WorkspaceEntry | undefined | Promise<WorkspaceEntry | undefined>
    archiveSession?: (sessionId: string, options?: { stopActivity?: boolean }) => Promise<unknown>
  }
  // 会话选项（2026-10-27 加）：两样都走宿主自己的写通道，本插件不自己拼状态。
  // preset 走 `create({ agentPreset })` —— ds-bot 0.2.2 就是这么开的会话
  // （`ds-bot/src/host/roster.js:87` `create({ ...place, ...await botPreset() })`，
  // `:70-75` 的 botPreset 返回 `{ agentPreset: 'standard' }`），实测落盘可见会话 header 里的
  // `"agentPreset":"standard"`（F:\AgentData\dsh\data\sessions\--F-DSBOT--/*/session.v4.jsonl.zstd 解压首行）。
  // 不走 agentPresets.select：那个方法对「已开跑」的会话硬锁（agent-preset/locked），
  // 且要重编 agent 组合；create 时传参一次成型，没有这两个麻烦。
  agentPresets?: {
    list?: () => Promise<{ id?: string; broken?: unknown }[]>
  }
  commands?: {
    execute?: (agent: unknown, line: string, attachments: unknown[], signal: AbortSignal) => Promise<unknown>
  }
}

// 把宿主 ctx 上的四个服务取出来：先直接取属性，取不到再走 ctx.get。
// 直接取属性在真实宿主里可能对「未 inject 的服务」抛错，故两边都包 try —— 一律降级成 undefined，
// 交给 preflight 报出「缺了哪一个」，而不是让异常穿透到插件树。
type ServiceName = 'tools' | 'sessionController' | 'sessionTitle' | 'workspaceRegistry' | 'agentPresets' | 'commands'

function pickService<T>(ctx: HostCtx, name: ServiceName): T | undefined {
  try {
    const direct = (ctx as unknown as Record<string, unknown> | undefined)?.[name]
    if (direct !== undefined && direct !== null) return direct as T
  } catch {
    /* 未 inject 的服务直接访问可能抛错，改走 ctx.get */
  }
  try {
    return ctx?.get?.(name) as T | undefined
  } catch {
    return undefined
  }
}

export function resolveServices(ctx: HostCtx): HostCtx {
  return {
    get: (name: string) => safeGet(ctx, name),
    tools: pickService(ctx, 'tools'),
    sessionController: pickService(ctx, 'sessionController'),
    sessionTitle: pickService(ctx, 'sessionTitle'),
    workspaceRegistry: pickService(ctx, 'workspaceRegistry'),
    agentPresets: pickService(ctx, 'agentPresets'),
    commands: pickService(ctx, 'commands'),
  }
}

function safeGet(ctx: HostCtx, name: string): unknown {
  try {
    return ctx?.get?.(name)
  } catch {
    return undefined
  }
}

export class SessionCreateError extends Error {
  code: string
  constructor(code: string, message: string) {
    super(message)
    this.name = 'SessionCreateError'
    this.code = code
  }
}

/** 把任意 catch 到的东西变成一句人能读的原因。 */
function reasonOf(error: unknown): string {
  return error instanceof Error ? error.message : String(error)
}

// 最小探针（方案文档 §三.9）：返回宿主缺的能力；空数组 = 齐备。
// 这一步同时是「第三方插件到底拿不拿得到这些服务」的当场取证。
export function preflight(ctx: HostCtx): string[] {
  const missing: string[] = []
  if (typeof ctx?.tools?.register !== 'function') missing.push('tools.register')
  if (typeof ctx?.sessionController?.create !== 'function') missing.push('sessionController.create')
  if (typeof ctx?.sessionController?.prompt !== 'function') missing.push('sessionController.prompt')
  if (typeof ctx?.sessionController?.resolveAgent !== 'function') missing.push('sessionController.resolveAgent')
  if (typeof ctx?.sessionTitle?.rename !== 'function') missing.push('sessionTitle.rename')
  if (typeof ctx?.workspaceRegistry?.get !== 'function') missing.push('workspaceRegistry.get')
  if (typeof ctx?.workspaceRegistry?.archiveSession !== 'function') missing.push('workspaceRegistry.archiveSession')
  return missing
}

// 读回只需要两项，不该被建会话所需的其余服务连坐（否则读回会报一堆不相干的缺失项）。
export function preflightRead(ctx: HostCtx): string[] {
  const missing: string[] = []
  if (typeof ctx?.sessionController?.resolveAgent !== 'function') missing.push('sessionController.resolveAgent')
  if (typeof ctx?.sessionController?.page !== 'function') missing.push('sessionController.page')
  return missing
}

// 会话选项是可选能力：缺了不影响「不传参」的派活，所以不进 preflight（那会拦住整个插件）。
// 单独报一句，让「装了插件却缺这两个服务」在加载时就暴露，而不是等第一次带参派活才炸。
export function preflightOptions(ctx: HostCtx): string[] {
  const missing: string[] = []
  if (typeof ctx?.agentPresets?.list !== 'function') missing.push('agentPresets.list')
  if (typeof ctx?.commands?.execute !== 'function') missing.push('commands.execute')
  return missing
}

export type CreateArgs = {
  title?: string
  prompt?: string
  folder?: string
  workspace?: string
  /** 会话开跑前要设的 agent 预设（宿主那四个：standard / minimal / ptc / creator）。 */
  preset?: string
  /** 会话的权限模式（宿主三档：read-only / workspace-write / danger-full-access）。 */
  permission?: string
}
/** 这一单用到的会话选项：preset 在建会话时写进 header；permission 是**请求值**（无回读）。 */
export type SessionOptions = { preset?: string; permission?: string }
export type CreateResult = {
  sessionId: string
  title: string
  placement: string
  renamed: boolean
  /** 实际用的 agent 预设：建会话时写进 header，宿主不接受就是没建成。 */
  preset?: string
  /** **请求**的权限模式。宿主没有回读通道证实它生效，所以这里只敢写「请求值」。 */
  permission?: string
  /** 台账写入失败时的原因；有值 = 会话已建但没记上 ID，调用方必须如实说出来。 */
  ledgerError?: string
  /** 台账路径（成功写入时给出），便于调用方事后自己去看。 */
  ledgerPath?: string
}

// 纯校验：不做任何 I/O，全部 fail-closed。
export function validate(args: CreateArgs): { title: string; prompt: string; folder?: string; workspace?: string } {
  const title = (args?.title ?? '').trim()
  const prompt = (args?.prompt ?? '').trim()
  const folder = args?.folder?.trim() || undefined
  const workspace = args?.workspace?.trim() || undefined
  if (title === '') throw new SessionCreateError('missing-title', 'a title is required; no Session was made.')
  if (prompt === '') throw new SessionCreateError('missing-prompt', 'a prompt is required; no Session was made.')
  if (folder !== undefined && workspace !== undefined) {
    throw new SessionCreateError('two-placements', 'give either folder or workspace, not both; no Session was made.')
  }
  if (folder === undefined && workspace === undefined) {
    throw new SessionCreateError('no-placement', 'give exactly one of folder or workspace; no Session was made.')
  }
  return { title, prompt, folder, workspace }
}

// 两个选项只是名字，合法值由宿主判定：名字集合会随宿主升级漂移，本插件硬编码白名单迟早误伤
// （而且宿主的报错本身就带可用值 —— `/permission` 的 unknown preset 会列出 names）。
// 这里只做「空串等于没给」的规整，不做猜测式校验。
export function readOptions(args: CreateArgs): SessionOptions {
  const preset = args?.preset?.trim() || undefined
  const permission = args?.permission?.trim() || undefined
  return {
    ...(preset === undefined ? {} : { preset }),
    ...(permission === undefined ? {} : { permission }),
  }
}

export async function isFolder(path: string): Promise<boolean> {
  try {
    return (await stat(path)).isDirectory()
  } catch {
    return false
  }
}

export async function resolvePlacement(ctx: HostCtx, folder?: string, workspace?: string): Promise<{ placement: Record<string, unknown>; text: string }> {
  if (folder !== undefined) {
    if (!(await isFolder(folder))) {
      throw new SessionCreateError('folder-missing', `"${folder}" is not an existing folder; no Session was made.`)
    }
    return { placement: { cwd: folder }, text: `folder ${folder}` }
  }
  const wanted = workspace as string
  const registry = ctx.workspaceRegistry as NonNullable<HostCtx['workspaceRegistry']>
  const direct = registry.get?.(wanted)
  const found = direct ?? (await registry.resolveByPath?.(wanted))
  if (!found) {
    throw new SessionCreateError('workspace-unknown', `no DSH workspace matches "${wanted}"; no Session was made.`)
  }
  const id = found.id ?? (direct === undefined ? undefined : wanted)
  if (typeof id !== 'string' || id === '') {
    // 不能拿「路径」当 workspaceId 传下去：ds-bot 对未知 id 的处置正是静默换到团队工作区。
    throw new SessionCreateError('workspace-unknown', `the DSH workspace matched "${wanted}" but gave no id; no Session was made.`)
  }
  return { placement: { workspaceId: id }, text: `workspace ${found.title ?? id}` }
}

// 归档是尽力而为，但**结果必须如实回报**：失败时不能对外说「已归档」。
async function archiveQuietly(ctx: HostCtx, sessionId: string): Promise<{ ok: boolean; reason?: string }> {
  try {
    await ctx.workspaceRegistry?.archiveSession?.(sessionId, { stopActivity: true })
    return { ok: true }
  } catch (error) {
    return { ok: false, reason: error instanceof Error ? error.message : String(error) }
  }
}

// ---------------------------------------------------------------------------
// 会话选项：agent 预设 + 权限模式（2026-10-27 加，用户要求「派活时能选」）
// ---------------------------------------------------------------------------

/** 把任意值压成一句短说明（报错要用，别把整个对象塞进消息）。 */
export function shortOf(value: unknown): string {
  if (typeof value === 'string') return value
  if (value === undefined) return 'undefined'
  if (value === null) return 'null'
  try {
    return JSON.stringify(value) ?? String(value)
  } catch {
    return String(value)
  }
}

// preset 必须在**建会话之前**解析：它在 create 的 header 里就定死了（会话一开跑就锁），
// 所以名字错、预设坏了，都该在还没建会话时就拦住，而不是建完再归档。
export async function resolvePreset(ctx: HostCtx, preset: string): Promise<string> {
  const presets = ctx.agentPresets
  if (typeof presets?.list !== 'function') {
    throw new SessionCreateError('host-missing', 'this harness has no agentPresets.list, so `preset` could not be checked. No Session was made.')
  }
  const entries = await presets.list()
  const all = Array.isArray(entries) ? entries : []
  const ids = all.map(entry => entry?.id).filter((id): id is string => typeof id === 'string')
  const found = all.find(entry => entry?.id === preset)
  if (found === undefined) {
    const available = ids.length === 0 ? '(the harness reported none)' : ids.join(', ')
    throw new SessionCreateError('preset-unknown', `no agent preset "${preset}" on this harness (available: ${available}). No Session was made.`)
  }
  if (found.broken !== undefined) {
    // ds-bot 也是这么判的（roster.js:73 `preset.broken === undefined`）——坏预设造出来的会话
    // 是「工具跑不起来」，比直接失败更难排查。
    const available = ids.length === 0 ? '(the harness reported none)' : ids.join(', ')
    throw new SessionCreateError('preset-broken', `the agent preset "${preset}" is broken on this harness (${shortOf(found.broken)}); available: ${available}. No Session was made.`)
  }
  return preset
}

// 宿主 commands.execute 回 `{ commandId, result: { kind, text? } }`。
// **白名单判定**：明确的 error 是失败，明确的 success 是成功，**其余一律按失败**。
// 上一版写成「只有 error 才算失败、其余当没拒」，那会把「认不出的返回形状」当成设上了——
// 与读台账那次「读不出来当没有」是同一类毛病。宁可多报一次错，不许少报一次没设上。
export function commandVerdict(outcome: unknown): { ok: true } | { ok: false; reason: string } {
  const result = (outcome as { result?: { kind?: unknown; text?: unknown } } | undefined)?.result
  const kind = result?.kind
  if (kind === 'success') return { ok: true }
  if (kind === 'error') {
    return { ok: false, reason: typeof result?.text === 'string' && result.text !== '' ? result.text : 'the host rejected the command' }
  }
  // 带上原始形状：形状不符时，这一句就是修下一版的全部依据（省一次重启）。
  return { ok: false, reason: `unrecognized command result (kind=${shortOf(kind)}; raw=${shortOf(outcome).slice(0, 300)})` }
}

// 权限走 `/permission <名>` 命令：宿主把权限预设注册成了一条命令，Pocket 新建会话也用它。
// 这一支**没有回读**（没读 `permission/preset` 事件核对），所以对外只能说「请求了」，
// 不能说「生效了」——除非哪天补上读回。
async function applyPermission(
  ctx: HostCtx,
  controller: NonNullable<HostCtx['sessionController']>,
  sessionId: string,
  permission: string,
  signal?: AbortSignal,
  timeoutMs?: number,
): Promise<void> {
  const commands = ctx.commands
  if (typeof commands?.execute !== 'function') {
    throw new SessionCreateError('host-missing', 'this harness has no commands.execute, so `permission` was not applied.')
  }
  const agent = (await controller.resolveAgent?.(sessionId))?.agent
  if (agent === undefined) {
    throw new SessionCreateError('options-failed', 'the Session was made but it could not be reached to set its permission (session unavailable).')
  }
  const outcome = await commands.execute(
    agent,
    `/permission ${permission}`,
    [],
    signal ?? AbortSignal.timeout(timeoutMs ?? SESSION_OPTION_TIMEOUT_MS),
  )
  const verdict = commandVerdict(outcome)
  if (!verdict.ok) {
    throw new SessionCreateError('options-failed', `the host refused the permission "${permission}": ${verdict.reason}`)
  }
}

// 出错那一单也要留痕：既不回 ID、又不记台账，事后谁都没法在会话列表里找到那个空会话。
async function recordFailedDispatch(
  ledgerPath: string,
  record: { sessionId: string; title: string; placement: string; promptHead: string; failure: string; preset?: string; dispatcherSessionId?: string },
): Promise<string | undefined> {
  try {
    await appendDispatch(ledgerPath, {
      sessionId: record.sessionId,
      title: record.title,
      placement: record.placement,
      dispatchedAt: Date.now(),
      promptHead: record.promptHead,
      ...(record.preset === undefined ? {} : { preset: record.preset }),
      ...(record.dispatcherSessionId === undefined ? {} : { dispatcherSessionId: record.dispatcherSessionId }),
      failed: record.failure,
    })
    return undefined
  } catch (error) {
    return error instanceof Error ? error.message : String(error)
  }
}

export async function createSessionIn(
  ctx: HostCtx,
  args: CreateArgs,
  // opts.signal 一旦给了，就等于把超时责任交给调用方——本函数不再自建上限（通往宿主的调用只传两个实参，故生产路径仍是 30 秒）。
  // opts.dispatcherSessionId 记进台账，供完成回执投回派活人（2026-10-28 加；缺省不写）。
  opts: { timeoutMs?: number; signal?: AbortSignal; ledger?: string; dispatcherSessionId?: string } = {},
): Promise<CreateResult> {
  const missing = preflight(ctx)
  if (missing.length > 0) {
    throw new SessionCreateError('host-missing', `this harness is missing ${missing.join(', ')}; no Session was made.`)
  }
  const { title, prompt, folder, workspace } = validate(args)
  const options = readOptions(args)
  // preset 在建会话之前就要定好：它写进会话 header，会话一开跑就不能再换。
  // 名字错、预设坏了都在这拦下，不建会话（比建完再归档干净）。
  const preset = options.preset === undefined ? undefined : await resolvePreset(ctx, options.preset)
  // 权限那一路缺服务也在建会话之前拦下：check 在 applyPermission 里也有，但那时会话已经建了，
  // 只能建完再归档，白留一个空会话。
  if (options.permission !== undefined && typeof ctx.commands?.execute !== 'function') {
    throw new SessionCreateError('host-missing', 'this harness has no commands.execute, so `permission` could not be applied. No Session was made.')
  }
  const { placement, text } = await resolvePlacement(ctx, folder, workspace)

  const controller = ctx.sessionController as NonNullable<HostCtx['sessionController']>
  const created = await controller.create?.({ ...placement, ...(preset === undefined ? {} : { agentPreset: preset }) })
  const sessionId = created?.sessionId
  if (typeof sessionId !== 'string' || sessionId === '') {
    throw new SessionCreateError('no-session-id', 'the host returned no session id; nothing was written.')
  }
  const ledgerPath = opts.ledger ?? defaultLedgerPath()

  // 标题失败不致命，但要如实带出来，不能假装改过了。
  let renamed = true
  try {
    const resolved = await controller.resolveAgent?.(sessionId)
    if (!resolved || 'error' in resolved) {
      throw new Error(resolved?.error?.message ?? 'session unavailable')
    }
    await ctx.sessionTitle?.rename?.(resolved.agent?.session, title)
  } catch {
    renamed = false
  }

  // 权限必须在投提示词之前设好（会话一开跑，用户看到的默认档就已经定了）。
  // 设不成就整单失败并归档 —— 让用户在错档下干活，比不派这一单更糟。
  if (options.permission !== undefined) {
    try {
      await applyPermission(ctx, controller, sessionId, options.permission, opts.signal, opts.timeoutMs)
    } catch (error) {
      const archived = await archiveQuietly(ctx, sessionId)
      const tail = archived.ok
        ? `the Session ${sessionId} was archived.`
        : `the Session ${sessionId} may still be in the session list (archiving it failed: ${archived.reason}).`
      // 归档失败时这单既没 ID 也没账，事后谁都找不到那个空会话 —— 补一条台账。
      const failure = error instanceof Error ? error.message : String(error)
      const ledgerNote = await recordFailedDispatch(ledgerPath, {
        sessionId,
        title,
        placement: text,
        promptHead: headOf(prompt, 200),
        failure,
        ...(preset === undefined ? {} : { preset }),
        ...(opts.dispatcherSessionId === undefined ? {} : { dispatcherSessionId: opts.dispatcherSessionId }),
      })
      const note = ledgerNote === undefined
        ? ` It was recorded in the dispatch ledger (${ledgerPath}) so it can be found later.`
        : ` The dispatch ledger could not record it either (${ledgerNote}); keep this id by hand.`
      const code = error instanceof SessionCreateError ? error.code : 'options-failed'
      throw new SessionCreateError(code, `the Session was made but its permission was not applied (${reasonOf(error)}); ${tail}${note}`)
    }
  }
  const applied: SessionOptions = {
    ...(preset === undefined ? {} : { preset }),
    ...(options.permission === undefined ? {} : { permission: options.permission }),
  }

  try {
    await controller.prompt?.(
      {
        requestId: randomUUID(),
        sessionId,
        mode: 'queue',
        content: [{ type: 'text', text: prompt }],
      },
      // opts.signal 优先：调用方自带取消信号时用它（也让它可被单测 —— bun 1.3.13 的
      // AbortSignal.timeout 在没有其它待办定时器时不触发，只有它一个 pending 时会永久挂住）。
      opts.signal ?? AbortSignal.timeout(opts.timeoutMs ?? PROMPT_TIMEOUT_MS),
    )
  } catch (error) {
    const reason = error instanceof Error ? error.message : String(error)
    const archived = await archiveQuietly(ctx, sessionId)
    const tail = archived.ok
      ? `the Session ${sessionId} was archived.`
      : `the Session ${sessionId} may still be in the session list (archiving it failed: ${archived.reason}).`
    throw new SessionCreateError('prompt-failed', `the Session was made but the prompt did not go through (${reason}); ${tail}`)
  }

  // 会话已经在跑了，台账写不进去不该把整次派送判成失败 —— 但必须如实回报，
  // 否则调用方会以为「ID 记住了」，事后无处可查。
  let ledgerError: string | undefined
  try {
    await appendDispatch(ledgerPath, {
      sessionId,
      title,
      placement: text,
      dispatchedAt: Date.now(),
      promptHead: headOf(prompt, 200),
      ...(applied.preset === undefined ? {} : { preset: applied.preset }),
      ...(applied.permission === undefined ? {} : { permission: applied.permission }),
      ...(opts.dispatcherSessionId === undefined ? {} : { dispatcherSessionId: opts.dispatcherSessionId }),
    })
  } catch (error) {
    ledgerError = error instanceof Error ? error.message : String(error)
  }

  return { sessionId, title, placement: text, renamed, ...applied, ledgerPath, ...(ledgerError === undefined ? {} : { ledgerError }) }
}

// ---------------------------------------------------------------------------
// 派送台账：派送时记下会话 ID（用户 2026-10-26 要求）
// ---------------------------------------------------------------------------

export const LEDGER_FILE = 'dispatched-sessions.jsonl'

// 台账落点：`$DSH_HOME/bot/session-create/dispatched-sessions.jsonl`（DSH_HOME 缺省 ~/.dsh）。
// 为什么放在 `bot/` 下（用户 2026-10-26 定）：「Bot 派活 → 工作区会话 → 把结果取回来」这条交接
// 记录属于 DS Bot 自己的账，不该与 DS Bot 平级另立一处。DS Bot 自己的 home 就是 `<DSH_HOME>/bot`
// ——`ds-bot/index.js:57` 逐字 `const home = config.home ?? join(dshHome, 'bot')`，本插件跟随同一规则。
// 例外：若 ds-bot 的 home 被它自己的 profile 配置（`config.home`）改到别处，须用
// DSH_SESSION_CREATE_LEDGER 手动对齐——本插件读不到 ds-bot 的配置。
export function defaultLedgerPath(env: Record<string, string | undefined> = process.env, home: string = homedir()): string {
  const explicit = (env.DSH_SESSION_CREATE_LEDGER ?? '').trim()
  if (explicit !== '') return explicit
  const root = (env.DSH_HOME ?? '').trim() || join(home, '.dsh')
  return join(root, 'bot', 'session-create', LEDGER_FILE)
}

export type DispatchRecord = {
  sessionId: string
  title: string
  placement: string
  dispatchedAt: number
  /** 提示词开头，供事后认出这是哪一单活。 */
  promptHead: string
  /** 派送时设过的 agent 预设（没设就不写）。 */
  preset?: string
  /** 派送时请求的权限模式（没设就不写；宿主未回传生效值）。 */
  permission?: string
  /** 这一单在建了会话之后失败了（归档不了时用它留痕，便于事后找到那个空会话）。 */
  failed?: string
  /**
   * 派活人的会话 id（工具执行上下文里的 `exec.agent.session.id`，2026-10-28 加）。
   * 完成回执投给它；没有这一项的老记录不发回执（宁可漏一条，不投错人）。
   */
  dispatcherSessionId?: string
  /** 上次读回读到的位置（headSeq），用来判断有没有新内容。 */
  lastReadSeq?: number
  lastReadAt?: number
  /** 上次把完成回执投回派活人的时刻。同一段静默期只投一次（幂等）。 */
  notifiedAt?: number
}

export function headOf(text: string, max: number): string {
  if (text.length <= max) return text
  // 不切半个字符：如果 max 位置上正好是高代理项，就退一格。
  return text.slice(0, /[\uD800-\uDBFF]/.test(text[max - 1] ?? '') ? max - 1 : max)
}

/** 追加一条派送记录。文件不存在就建目录再建文件。 */
export async function appendDispatch(ledgerPath: string, record: DispatchRecord): Promise<void> {
  await mkdir(dirname(ledgerPath), { recursive: true })
  await appendFile(ledgerPath, `${JSON.stringify(record)}\n`, 'utf8')
}

/**
 * 读台账，按会话去重（同一 ID 只留最后一条），返回按派送时间升序的列表（最旧在前）。
 * 坏行跳过：台账是日志，坏一行不该让整条线读不出来。
 *
 * **文件不存在**与**文件读不出来**是两件事，必须分开（Truth-Guard 闸门二退回 2，2026-10-26）：
 * 前者意味着「一单都还没派送过」，返回空是对的；后者（权限、被占用、路径其实是个目录、盘掉线）
 * 若也当成空，调用方就会说出一句与事实相反的话——「还没派送过」，用户会以为活根本没派出去。
 * 所以非 ENOENT 一律如实抛出，由上层把原因带给用户。
 */
export async function readLedger(ledgerPath: string): Promise<DispatchRecord[]> {
  let text: string
  try {
    text = await readFile(ledgerPath, 'utf8')
  } catch (error) {
    if ((error as { code?: unknown } | null)?.code === 'ENOENT') return []
    throw new SessionCreateError('ledger-unreadable', `the dispatch ledger ${ledgerPath} exists but could not be read (${reasonOf(error)}).`)
  }
  const bySession = new Map<string, DispatchRecord>()
  for (const line of text.split('\n')) {
    if (line.trim() === '') continue
    try {
      const record = JSON.parse(line) as DispatchRecord
      if (typeof record?.sessionId !== 'string' || record.sessionId === '') continue
      bySession.set(record.sessionId, record)
    } catch {
      /* 坏行跳过 */
    }
  }
  const records = [...bySession.values()]
  // 按派送时间升序（同一时间保持原有先后，Array.sort 是稳定的）。append 顺序与时间一致时等价，
  // 但时间更权威：同一会话被重复派送时，先出现的旧记录不该压过后来那一单。
  records.sort((a, b) => (Number(a.dispatchedAt) || 0) - (Number(b.dispatchedAt) || 0))
  return records
}

/** 记下「这个会话读到第几号事件了」。返回是否找到了这条记录。 */
export async function markRead(ledgerPath: string, sessionId: string, seq: number, at: number = Date.now()): Promise<boolean> {
  const records = await readLedger(ledgerPath)
  const at_ = records.findIndex(record => record.sessionId === sessionId)
  if (at_ < 0) return false
  records[at_] = { ...records[at_], lastReadSeq: seq, lastReadAt: at }
  const body = records.map(record => `${JSON.stringify(record)}\n`).join('')
  // 同目录临时文件 + 改名：避免读到写了一半的台账。
  const temp = `${ledgerPath}.tmp-${randomUUID()}`
  await writeFile(temp, body, 'utf8')
  await rename(temp, ledgerPath)
  return true
}

/**
 * 记下「这个会话在这一段静默期已经回过执了」（与 markRead 同形：同目录临时文件 + 改名）。
 * 同一实例内的重复投递由内存集合挡住，这一项管的是**跨实例/重启后**的幂等，也是事后可审计的凭据。
 */
export async function markNotified(ledgerPath: string, sessionId: string, at: number = Date.now()): Promise<boolean> {
  const records = await readLedger(ledgerPath)
  const index = records.findIndex(record => record.sessionId === sessionId)
  if (index < 0) return false
  records[index] = { ...records[index], notifiedAt: at }
  const body = records.map(record => `${JSON.stringify(record)}\n`).join('')
  const temp = `${ledgerPath}.tmp-${randomUUID()}`
  await writeFile(temp, body, 'utf8')
  await rename(temp, ledgerPath)
  return true
}

// ---------------------------------------------------------------------------
// 会话读回：用会话 ID 取回该会话的转写（用户 2026-10-26 要求）
// ---------------------------------------------------------------------------

export type TranscriptMessage = { role: 'user' | 'assistant'; text: string; seq: number; time: number }
export type TranscriptStatus = 'not-started' | 'running' | 'idle'
export type RenderedTranscript = {
  status: TranscriptStatus
  /** 页里见到的最大的 turn 号（没有 turn/start 就是 undefined）。 */
  turn?: number
  /** 页里见到的最大的事件 seq。 */
  headSeq: number
  messages: TranscriptMessage[]
}

type AnyEvent = { type?: string; seq?: number; time?: number; data?: Record<string, unknown> }

// 只取 text 块，丢掉 reasoning / tool-call —— 与 ds-bot 的 textOf（src/host/text.js:14）同口径。
function blockText(content: unknown): string {
  if (!Array.isArray(content)) return ''
  return content
    .filter((block): block is { type: string; text: string } => {
      const b = block as { type?: unknown; text?: unknown } | null
      return b?.type === 'text' && typeof b.text === 'string'
    })
    .map(block => block.text)
    .join('\n')
    .trim()
}

function clipText(text: string): string {
  if (text.length <= MESSAGE_CLIP) return text
  return `${text.slice(0, MESSAGE_CLIP)}… (cut; ${text.length} characters in all)`
}

/**
 * 把宿主 page 里的事件渲染成「谁说了什么 + 这轮跑完没有」。
 * 纯函数，事件形状按真实会话存储实测（见 docs §十一 的取证表）：
 *   turn/start {turn} · turn/end {turn, reason} · user/message {content, source:{kind}} ·
 *   assistant/message {message:{content:[{type:'text',text}]}}
 */
export function renderTranscript(events: unknown[]): RenderedTranscript {
  let turn: number | undefined
  let headSeq = 0
  const ended = new Set<number>()
  const messages: TranscriptMessage[] = []
  for (const raw of events) {
    const event = raw as AnyEvent | null
    if (event === null || typeof event !== 'object') continue
    if (typeof event.seq === 'number' && Number.isInteger(event.seq)) headSeq = Math.max(headSeq, event.seq)
    if (event.type === 'turn/start') {
      const n = event.data?.turn
      if (typeof n === 'number' && Number.isInteger(n)) turn = n
      continue
    }
    if (event.type === 'turn/end') {
      const n = event.data?.turn
      if (typeof n === 'number' && Number.isInteger(n)) ended.add(n)
      continue
    }
    if (event.type === 'user/message') {
      // 只有真人输入算「任务内容」：handoff 便条、群聊转发等不是。
      const source = event.data?.source as { kind?: unknown } | undefined
      if (source?.kind !== 'user') continue
      const text = blockText(event.data?.content)
      if (text === '') continue
      messages.push({ role: 'user', text: clipText(text), seq: event.seq ?? 0, time: event.time ?? 0 })
      continue
    }
    if (event.type === 'assistant/message') {
      const message = event.data?.message as { content?: unknown } | undefined
      const text = blockText(message?.content)
      if (text === '') continue
      messages.push({ role: 'assistant', text: clipText(text), seq: event.seq ?? 0, time: event.time ?? 0 })
    }
  }
  const status: TranscriptStatus = turn === undefined ? 'not-started' : ended.has(turn) ? 'idle' : 'running'
  return { status, turn, headSeq, messages }
}

export type ReadArgs = { sessionId?: string; last?: number }
export type Transcript = RenderedTranscript & {
  sessionId: string
  /** 状态是宿主直给（host）还是从事件推出来的（transcript）——不许把推断说成宿主结论。 */
  statusFrom: 'host' | 'transcript'
  title?: string
  placement?: string
  dispatchedAt?: number
  /** 上次读到的位置（台账），没记过就没有。 */
  lastReadSeq?: number
  /** 比上次多出来的事件数；没记过上次位置就没有。 */
  newEvents?: number
  /** 更早的事件还在（把 last 调大或再读一次能取到）。 */
  hasMore: boolean
  /** 与台账有关的失败原因：台账读不出来（读会话本身没受影响），或读到了但记不上。 */
  ledgerError?: string
}

/** 按会话 ID 取回转写；不给 ID 就取台账里最后一条派送的会话。 */
export async function readSessionIn(
  ctx: HostCtx,
  args: ReadArgs = {},
  opts: { ledger?: string; signal?: AbortSignal; timeoutMs?: number; markRead?: boolean } = {},
): Promise<Transcript> {
  const missing = preflightRead(ctx)
  if (missing.length > 0) {
    throw new SessionCreateError('host-missing', `this harness cannot read a Session's history: it is missing ${missing.join(', ')}.`)
  }

  const ledgerPath = opts.ledger ?? defaultLedgerPath()
  const wanted = (args.sessionId ?? '').trim()
  let fromLedger: DispatchRecord | undefined
  let sessionId = wanted
  let ledgerError: string | undefined
  if (sessionId === '') {
    // 不给 ID 就只能靠台账定位会话——台账读不出来必须当场报错（ledger-unreadable），不去猜一个。
    const records = await readLedger(ledgerPath)
    fromLedger = records.at(-1)
    if (fromLedger === undefined) {
      throw new SessionCreateError('no-session', `give a session id: the dispatch ledger ${ledgerPath} has no entry yet.`)
    }
    sessionId = fromLedger.sessionId
  } else {
    // 给了 ID 时，台账只是附加信息（标题 / 落位 / 派送时刻）：它读不出来不该挡住读会话本身，
    // 但也**不许静默**——如实记下原因，随结果一起带出去（Truth-Guard 闸门二退回 2）。
    try {
      fromLedger = (await readLedger(ledgerPath)).find(record => record.sessionId === sessionId)
    } catch (error) {
      ledgerError = reasonOf(error)
    }
  }

  const controller = ctx.sessionController as NonNullable<HostCtx['sessionController']>
  const resolved = await controller.resolveAgent?.(sessionId)
  if (!resolved || 'error' in resolved || resolved.agent?.session === undefined || resolved.agent.session === null) {
    throw new SessionCreateError('session-unknown', `no Session "${sessionId}" is known to this harness${resolved?.error?.message ? ` (${resolved.error.message})` : ''}.`)
  }
  const seq = Number(resolved.agent.session.seq)
  if (!Number.isFinite(seq)) {
    // 拿不到 seq 就不知道读到哪里截止（ds-bot 同样用 seq-1 当 throughSeq，parts.js:1289）。
    throw new SessionCreateError('session-no-seq', `the harness gave no sequence number for Session "${sessionId}"; nothing was read.`)
  }

  const last = clamp(args.last ?? MESSAGES_DEFAULT, 1, MESSAGES_MAX)
  let page: SessionPage | undefined
  try {
    page = await controller.page?.(
      { address: { kind: 'session', sessionId }, throughSeq: seq - 1, maxMessages: last },
      opts.signal ?? AbortSignal.timeout(opts.timeoutMs ?? HISTORY_TIMEOUT_MS),
    )
  } catch (error) {
    const reason = error instanceof Error ? error.message : String(error)
    throw new SessionCreateError('read-failed', `the harness would not give Session "${sessionId}" back (${reason}).`)
  }
  if (page === undefined) {
    throw new SessionCreateError('read-failed', `the harness returned nothing for Session "${sessionId}".`)
  }

  const rendered = renderTranscript((page.records ?? []).map(record => record?.event))
  // 会话的「头」是 seq-1：seq 是下一个待分配号（ds-bot 用 seq-1 当 throughSeq，同前）。
  const headSeq = Math.max(seq - 1, rendered.headSeq)
  const newEvents = fromLedger?.lastReadSeq === undefined ? undefined : Math.max(0, headSeq - fromLedger.lastReadSeq)
  // 宿主直给的状态优先于「看事件推到哪」：前者是宿主的登记，后者是推断（且翻页会把早期事件截掉）。
  const hostStatus = resolved.agent?.status
  const status: TranscriptStatus = hostStatus === 'running' ? 'running' : hostStatus === 'idle' ? 'idle' : rendered.status
  const statusFrom: 'host' | 'transcript' = hostStatus === 'running' || hostStatus === 'idle' ? 'host' : 'transcript'

  // 台账这一轮读不出来时（ledgerError 已记下），不再试写：同一原因必然再失败，只会把报错刷两遍。
  if (opts.markRead !== false && ledgerError === undefined) {
    try {
      await markRead(ledgerPath, sessionId, headSeq)
    } catch (error) {
      ledgerError = reasonOf(error)
    }
  }

  return {
    ...rendered,
    status,
    statusFrom,
    headSeq,
    sessionId,
    hasMore: page.hasMore === true,
    ...(fromLedger?.title === undefined ? {} : { title: fromLedger.title }),
    ...(fromLedger?.placement === undefined ? {} : { placement: fromLedger.placement }),
    ...(fromLedger?.dispatchedAt === undefined ? {} : { dispatchedAt: fromLedger.dispatchedAt }),
    ...(fromLedger?.lastReadSeq === undefined ? {} : { lastReadSeq: fromLedger.lastReadSeq }),
    ...(newEvents === undefined ? {} : { newEvents }),
    ...(ledgerError === undefined ? {} : { ledgerError }),
  }
}

// ---------------------------------------------------------------------------
// 给已存在的会话补一条消息（2026-10-28 加，用户要求）
//
// 通道就是**派送与完成回执已经在用的那一条**：宿主 `sessionController.prompt`
// （`{ requestId, sessionId, mode:'queue', content }`，排队投递、不打断当前轮）。
// 两处生产先例：①本插件 createSessionIn 用它开新会话投第一条；②createDispatchNotifier
// 把回执投给**已经在跑的**派活人会话（core.ts 的 deliver）；③ds-bot 0.2.3
// `src/host/channel.js:422` 的 'send' 分支对**已存在**的 Bot 会话调的也是同一个方法。
// 所以这里不新造旁路，只把这条现成通道开成一个工具。
// ---------------------------------------------------------------------------

export type MessageArgs = { sessionId?: string; message?: string }
export type MessageResult = {
  sessionId: string
  /** 台账里记过的标题 / 落位，便于认人；台账里没有这一单就没有。 */
  title?: string
  placement?: string
  /** 台账读不出来时的原因；不影响投递，但要如实带出去。 */
  ledgerError?: string
}

// 补话只需要两项能力，不该被建会话所需的其余服务连坐。
export function preflightMessage(ctx: HostCtx): string[] {
  const missing: string[] = []
  if (typeof ctx?.sessionController?.resolveAgent !== 'function') missing.push('sessionController.resolveAgent')
  if (typeof ctx?.sessionController?.prompt !== 'function') missing.push('sessionController.prompt')
  return missing
}

export function validateMessage(args: MessageArgs): { sessionId: string; message: string } {
  const sessionId = (args?.sessionId ?? '').trim()
  const message = (args?.message ?? '').trim()
  if (sessionId === '') throw new SessionCreateError('missing-session-id', 'a sessionId is required; nothing was sent.')
  if (message === '') throw new SessionCreateError('missing-message', 'a message is required; nothing was sent.')
  return { sessionId, message }
}

/**
 * 往一个**已经存在**的会话里再投一条消息。不建会话、不改会话状态。
 *
 * 投递前先 resolveAgent：宿主认不出的会话 id 必须在这里就拒绝，
 * 不能把「什么都没投进去」说成「投好了」（fail-closed，与 readSessionIn 同一判据）。
 */
export async function messageSessionIn(
  ctx: HostCtx,
  args: MessageArgs = {},
  opts: { ledger?: string; signal?: AbortSignal; timeoutMs?: number } = {},
): Promise<MessageResult> {
  const missing = preflightMessage(ctx)
  if (missing.length > 0) {
    throw new SessionCreateError('host-missing', `this harness cannot send into a Session: it is missing ${missing.join(', ')}. Nothing was sent.`)
  }
  const { sessionId, message } = validateMessage(args)
  const controller = ctx.sessionController as NonNullable<HostCtx['sessionController']>

  // 台账只是附加信息（标题 / 落位）：读不出来不该挡住投递，但也不许静默。
  const ledgerPath = opts.ledger ?? defaultLedgerPath()
  let title: string | undefined
  let placement: string | undefined
  let ledgerError: string | undefined
  try {
    const record = (await readLedger(ledgerPath)).find(entry => entry.sessionId === sessionId)
    title = record?.title
    placement = record?.placement
  } catch (error) {
    ledgerError = reasonOf(error)
  }

  const resolved = await controller.resolveAgent?.(sessionId)
  if (!resolved || 'error' in resolved || resolved.agent?.session === undefined || resolved.agent.session === null) {
    throw new SessionCreateError('session-unknown', `no Session "${sessionId}" is known to this harness${resolved?.error?.message ? ` (${resolved.error.message})` : ''}; nothing was sent.`)
  }

  let outcome: unknown
  try {
    outcome = await controller.prompt?.(
      {
        requestId: randomUUID(),
        sessionId,
        mode: 'queue',
        content: [{ type: 'text', text: message }],
      },
      opts.signal ?? AbortSignal.timeout(opts.timeoutMs ?? MESSAGE_TIMEOUT_MS),
    )
  } catch (error) {
    throw new SessionCreateError('message-failed', `the message did not go into Session "${sessionId}" (${reasonOf(error)}); nothing was delivered.`)
  }
  // 宿主明确回 false = 拒收。其余（true / undefined / 认不出的形状）按已受理处理，
  // 但对外只说「已进入队列」，不说「它看过了」——后者只有读回才能证明。
  if (outcome === false) {
    throw new SessionCreateError('message-refused', `the harness refused the message for Session "${sessionId}"; nothing was delivered.`)
  }

  return { sessionId, ...(title === undefined ? {} : { title }), ...(placement === undefined ? {} : { placement }), ...(ledgerError === undefined ? {} : { ledgerError }) }
}

export type DispatchLine = {
  record: DispatchRecord
  status?: TranscriptStatus
  headSeq?: number
  newEvents?: number
  /** 读这一条失败时的原因（台账本身仍在）。 */
  error?: string
}

/** 台账 + 每一条此刻的状态：哪几条跑完了、哪几条有新内容。最新的排最前。 */
export async function listDispatchedIn(
  ctx: HostCtx,
  args: { limit?: number } = {},
  opts: { ledger?: string; signal?: AbortSignal; timeoutMs?: number } = {},
): Promise<{ ledgerPath: string; lines: DispatchLine[] }> {
  const ledgerPath = opts.ledger ?? defaultLedgerPath()
  const limit = clamp(args.limit ?? 5, 1, 20)
  const records = (await readLedger(ledgerPath)).slice(-limit).reverse()
  const lines: DispatchLine[] = []
  for (const record of records) {
    try {
      const transcript = await readSessionIn(ctx, { sessionId: record.sessionId, last: 6 }, { ...opts, ledger: ledgerPath, markRead: false })
      lines.push({
        record,
        status: transcript.status,
        headSeq: transcript.headSeq,
        ...(transcript.newEvents === undefined ? {} : { newEvents: transcript.newEvents }),
      })
    } catch (error) {
      lines.push({ record, error: error instanceof Error ? error.message : String(error) })
    }
  }
  return { ledgerPath, lines }
}

export function clamp(value: number, min: number, max: number): number {
  const n = Number.isFinite(value) ? Math.round(value) : min
  return Math.min(Math.max(n, min), max)
}

// 本机时刻，东八区当地实际时间：`YYYY-MM-DD HH:MM:SS`（用户口径，不加 +08:00）。
// 用固定 +08:00 偏移而不是进程本地时区：中国无夏令时，偏移恒等于 8 小时，
// 而宿主的 TZ 不必是 Asia/Shanghai —— 实测 `bun test` 进程里 getHours() 给的就是 UTC 小时，
// 直接用本地时区会把派送时刻显示错 8 小时（本函数是唯一给用户看时刻的地方）。
export const SHANGHAI_OFFSET_MS = 8 * 60 * 60 * 1000

export function stamp(time: number): string {
  if (!Number.isFinite(time) || time <= 0) return '?'
  const d = new Date(time + SHANGHAI_OFFSET_MS)
  const pad = (n: number) => String(n).padStart(2, '0')
  return `${d.getUTCFullYear()}-${pad(d.getUTCMonth() + 1)}-${pad(d.getUTCDate())} ${pad(d.getUTCHours())}:${pad(d.getUTCMinutes())}:${pad(d.getUTCSeconds())}`
}

// ---------------------------------------------------------------------------
// 会话完成回执：派出去的会话安静下来，主动把回执投回派活人的会话
// （2026-10-28 加；方案与全部行号见 docs/session-callback-mechanism-20261028.md）
//
// 为什么是这套形状：轮询读回要人去问，这里让宿主的事件面替我们盯着——只认台账里
// 本插件派出去的会话，等它安静下来，用插件**自己已有的** controller.prompt
// （mode:'queue'，排到下一轮、不打断当前轮）把一条短回执投给派活人。
// 不 import @deepseek-ai/dsh-llm、不用 createUserMessage、不碰 ctx.sessions.flush：
// 插件的 peerDependencies 只有 cordis 与 dsh-tools，多引一个模块就多一个装不上的可能。
// ---------------------------------------------------------------------------

/** 静默窗口：一轮结束后等这么久仍没有新的一轮，才认定「安静下来了」。 */
export const QUIET_WINDOW_MS = 120_000
/** 投一条回执是一次宿主调用；10 秒是上限而不是预期耗时。 */
export const NOTIFY_TIMEOUT_MS = 10_000

/** 事件面上的会话对象：ds-bot 的三处同形监听都只取 `session?.id`。 */
export type NotifySession = { id?: unknown }
export type NotifyEvent = { type?: unknown; data?: { turn?: unknown; reason?: { kind?: unknown } } }

type PendingQuiet = { endTime: number; handle: unknown }

export type NotifierDeps = {
  /** 台账落点；缺省 defaultLedgerPath() —— 与派送、读回同一个账。 */
  ledger?: string
  /** 静默窗口（毫秒），缺省 QUIET_WINDOW_MS。 */
  quietMs?: number
  now?: () => number
  /** 定时器可注入：单测用它把 120 秒窗口变成确定性的一步。 */
  setTimer?: (fn: () => void | Promise<void>, ms: number) => unknown
  clearTimer?: (handle: unknown) => void
  /**
   * 每次投递时**现解析**宿主服务。不要在 apply() 时拍成快照：插件加载常常早于服务就绪，
   * 快照会就此永久失效（同 resolveServices 的注释与 apply() 里那句 preflight 日志的成因）。
   */
  controllerOf?: () => HostCtx['sessionController']
  /** 跳过与失败都从这里出声，不静默。缺省打到宿主控制台，带插件前缀。 */
  log?: (line: string) => void
}

export type DispatchNotifier = {
  /** 宿主事件入口：`ctx.on('session/event', …)` 的两个实参直接喂进来。 */
  onEvent: (session: NotifySession | undefined, event: NotifyEvent | undefined) => Promise<void>
  /** 测试与诊断用：此刻正被合并静默期的会话。 */
  pending: () => { sessionId: string; endTime: number }[]
}

/**
 * 从工具执行上下文里取派活人的会话 id。ds-bot 的形状是 `exec.agent.session.id`；
 * 取不到就不记 —— 这不是失败，直接调 core 或老宿主本来就没有这个上下文。
 */
export function dispatcherSessionOf(exec: unknown): string | undefined {
  const id = (exec as { agent?: { session?: { id?: unknown } } } | undefined)?.agent?.session?.id
  return typeof id === 'string' && id !== '' ? id : undefined
}

/** 回执正文。首行必须带标题：派活人一眼认出这是哪一单。 */
export function receiptText(record: { title?: unknown }, sessionId: string, endTime: number, turn?: number, reason?: string): string {
  const title = typeof record?.title === 'string' && record.title !== '' ? record.title : '(untitled)'
  const last = `turn ${turn === undefined ? '?' : turn}${reason === undefined ? '' : `, reason: ${reason}`}`
  return [
    `[Dispatch receipt · ${title}]`,
    `The Session ${sessionId} you dispatched went quiet at ${stamp(endTime)} (${last}).`,
    `Read what it did with read_session_transcript (sessionId "${sessionId}"). No reply needed; act only if the result calls for it.`,
  ].join('\n')
}

export function createDispatchNotifier(deps: NotifierDeps = {}): DispatchNotifier {
  const ledgerPath = deps.ledger ?? defaultLedgerPath()
  const quietMs = deps.quietMs ?? QUIET_WINDOW_MS
  const now = deps.now ?? (() => Date.now())
  const setTimer = deps.setTimer ?? ((fn: () => void | Promise<void>, ms: number) => setTimeout(() => { void fn() }, ms))
  const clearTimer = deps.clearTimer ?? ((handle: unknown) => clearTimeout(handle as ReturnType<typeof setTimeout>))
  const log = deps.log ?? ((line: string) => console.warn(`[dsh-session-create] ${line}`))

  const pending = new Map<string, PendingQuiet>()
  // 同一实例内「这一段静默期已经投过」的会话。turn/start 时清掉：新一轮跑完允许再投一条。
  const notified = new Set<string>()

  async function recordOf(sessionId: string): Promise<DispatchRecord | undefined> {
    try {
      return (await readLedger(ledgerPath)).find(record => record.sessionId === sessionId)
    } catch (error) {
      // 台账读不出来（权限、被占用、路径其实是个目录）时**不发**：白名单判不了，就不投。
      log(`the dispatch ledger could not be read, so no receipt was sent for ${sessionId} (${reasonOf(error)}).`)
      return undefined
    }
  }

  async function resolveQuietly(controller: NonNullable<HostCtx['sessionController']>, sessionId: string): Promise<ResolvedAgent | undefined> {
    try {
      return await controller.resolveAgent?.(sessionId)
    } catch (error) {
      log(`the harness would not resolve the Session ${sessionId} (${reasonOf(error)}).`)
      return undefined
    }
  }

  async function deliver(sessionId: string, endTime: number, turn: number | undefined, reason: string | undefined): Promise<void> {
    if (notified.has(sessionId)) return
    const record = await recordOf(sessionId)
    if (record === undefined) return
    // 幂等（跨实例）：notifiedAt 是上次投递的时刻，落在这一段静默期之内就不再投。
    if (typeof record.notifiedAt === 'number' && record.notifiedAt >= endTime) return
    const dispatcher = record.dispatcherSessionId
    if (dispatcher === undefined || dispatcher === '') {
      log(`${sessionId} went quiet, but its ledger line has no dispatcherSessionId (it was dispatched before this feature), so no receipt was sent.`)
      return
    }
    // 自己派给自己（不该发生）：不投，免得自己把自己叫醒。
    if (dispatcher === sessionId) return
    const controller = deps.controllerOf?.()
    if (typeof controller?.resolveAgent !== 'function' || typeof controller?.prompt !== 'function') {
      log(`${sessionId} went quiet, but this harness has no sessionController.resolveAgent/prompt, so no receipt was sent.`)
      return
    }
    // 门二（复核空闲）：静默 ≠ 跑完 —— 等人工审批、等用户答问时同样安静。
    // 只认 'idle'，认不出的状态一律不投：宁可漏一条，也不投一条假回执。
    const resolved = await resolveQuietly(controller, sessionId)
    if (resolved?.agent?.status !== 'idle') {
      log(`${sessionId} went quiet, but the harness does not report it idle (status=${shortOf(resolved?.agent?.status)}), so no receipt was sent.`)
      return
    }
    // 派活方会话已销毁（被关掉/归档）：没地方投，跳过 —— 这不是错误。
    const target = await resolveQuietly(controller, dispatcher)
    if (target === undefined || target.error !== undefined || target.agent === undefined) {
      log(`${sessionId} went quiet, but the dispatching Session ${dispatcher} is gone, so there is nowhere to send the receipt.`)
      return
    }
    try {
      await controller.prompt(
        {
          requestId: randomUUID(),
          sessionId: dispatcher,
          mode: 'queue',
          content: [{ type: 'text', text: receiptText(record, sessionId, endTime, turn, reason) }],
        },
        AbortSignal.timeout(NOTIFY_TIMEOUT_MS),
      )
    } catch (error) {
      log(`the receipt for ${sessionId} did not go through (${reasonOf(error)}); the next turn to end will try again.`)
      return
    }
    notified.add(sessionId)
    try {
      await markNotified(ledgerPath, sessionId, now())
    } catch (error) {
      log(`the receipt for ${sessionId} was delivered, but the ledger could not record notifiedAt (${reasonOf(error)}).`)
    }
    log(`receipt for ${sessionId} delivered to the dispatching Session ${dispatcher}.`)
  }

  async function handle(session: NotifySession | undefined, event: NotifyEvent | undefined): Promise<void> {
    // 形状照抄 ds-bot 的同形监听（resume.js:179-185、turns.js:366-373）：先认 id，再认事件。
    const sessionId = typeof session?.id === 'string' ? session.id : undefined
    if (sessionId === undefined || sessionId === '') return
    const type = event?.type
    if (type !== 'turn/start' && type !== 'turn/end') return
    // 白名单（必须）：这个事件面是全宿主的。ds-bot 有一道
    // `if (!rt.isBotSession(id) && !rt.roomOf(id)) return`（turns.js:369）的守门，
    // 本插件拿不到、也不该依赖 ds-bot 的私有运行时 rt —— 同一道门由台账承担：
    // 台账里只有本插件亲手 create 出来的工作区/文件夹会话，Bot 聊天会话与群会话从不入账。
    const record = await recordOf(sessionId)
    if (record === undefined) return
    if (type === 'turn/start') {
      // 新一轮开跑：这一段静默期作废，等它再安静下来才重新计。
      const previous = pending.get(sessionId)
      if (previous !== undefined) {
        clearTimer(previous.handle)
        pending.delete(sessionId)
      }
      notified.delete(sessionId)
      return
    }
    const reason = typeof event?.data?.reason?.kind === 'string' ? event.data.reason.kind : undefined
    // 门一（假回执）：关停与叫停都不算跑完。宿主关停时每个 turn 都以 aborted 收尾
    // （resume.js:205-209 专跳这一支），用户手动叫停也是 aborted（turns.js:602/615/632）——
    // 照字面只认 turn/end，每次重启都会给在途单发一条假回执。
    if (reason === 'aborted') return
    const previous = pending.get(sessionId)
    if (previous !== undefined) clearTimer(previous.handle)
    const endTime = now()
    const turn = typeof event?.data?.turn === 'number' ? event.data.turn : undefined
    const handle = setTimer(() => {
      pending.delete(sessionId)
      return deliver(sessionId, endTime, turn, reason)
    }, quietMs)
    pending.set(sessionId, { endTime, handle })
  }

  return {
    async onEvent(session, event) {
      try {
        await handle(session, event)
      } catch (error) {
        // 监听器住在一个没人接返回值的宿主事件面上：异常不许穿透，也不许静默。
        log(`a session event could not be handled (${reasonOf(error)}).`)
      }
    },
    pending: () => [...pending.entries()].map(([sessionId, quiet]) => ({ sessionId, endTime: quiet.endTime })),
  }
}

/**
 * 把完成回执挂上宿主事件面。宿主 ctx 没有 `on` 时如实报一句并返回 undefined
 * （另外三个工具照常工作）—— 不静默降级，也不因此连累 preflight。
 */
export function installDispatchNotify(ctx: HostCtx, opts: { quietMs?: number; ledger?: string } = {}): DispatchNotifier | undefined {
  const on = ctx?.on
  if (typeof on !== 'function') {
    console.warn('[dsh-session-create] this harness context has no `on`, so a Session that finishes cannot report back by itself; read_session_transcript still works.')
    return undefined
  }
  const notifier = createDispatchNotifier({ ...opts, controllerOf: () => resolveServices(ctx).sessionController })
  on.call(ctx, 'session/event', (session: unknown, event: unknown) => {
    void notifier.onEvent(session as NotifySession, event as NotifyEvent)
  })
  return notifier
}
