// 宿主启动自检投递（2026-10-28，用户要求）：补上「重启后自动接续」整链的最后一段。
//
// 背景：宿主重启时在跑的 Bot 会话一并被杀，醒来后没有任何东西会主动说「刚重启过、盘上有接手指针」，
// 只能等用户手动说一句。本文件在 apply() 时注册延迟检查（最多三次），读盘上的指针，投一条唤醒消息。
//
// 四条需要在这里说清的设计判断（报告里也写了）：
//   ① **不先 resolveAgent**。宿主刚启动那几秒，目标会话往往还没被激活，resolveAgent 会把
//      「未激活」当成「不认识」从而永久跳过；prompt 才是真正的写入通道（messageSessionIn 里
//      resolveAgent 是给用户手动补话用的前置门，不是这里的语义）。
//   ② **因为 ① 说的那个窗口，单跳投递不够**：宿主刚起来那几秒恰恰是最可能投不进去的时刻，
//      所以改成 6s / 12s / 20s 三次尝试（累计约 38s），前两次失败各自再排一次，全失败才落
//      send-failed。宁可晚 20 秒叫醒，也好过在最需要它的窗口里一次就放弃。
//   ③ **ack 读不出来 / 坏 JSON / 没有 written_at ⇒ 当作「还没确认过」照投一次**。宁可多叫醒一次
//      （代价是一条消息），不可漏叫醒（代价是整条接续链断掉）。失败也会写一份 ack，但那份
//      **不含 written_at** —— 它只是盘上的证据，不参与幂等判断，所以下次启动照常重试。
//   ④ 延迟用 setTimeout 并 unref：不阻塞宿主启动，也不拖住宿主退出。
import { randomUUID } from 'node:crypto'
import { mkdir, readFile, rename, writeFile } from 'node:fs/promises'
import { dirname, join } from 'node:path'
import { resolveServices, type HostCtx } from './core'

/** 关闭开关：设成 '1' 时整段跳过（在任何文件被读取之前判断）。 */
export const AUTORESUME_ENV_FLAG = 'DSH_AUTORESUME_DISABLE'

// 指针与 ack 的落点**只在这里出现一次**：别处不许再拼这两个路径，也不许出现任何 C 盘路径。
export const AUTORESUME_STATE_DIR = 'F:\\DSBOT\\state'
export const AUTORESUME_PENDING_FILE = join(AUTORESUME_STATE_DIR, 'restart-pending.json')
export const AUTORESUME_ACK_FILE = join(AUTORESUME_STATE_DIR, 'restart-pending.ack.json')

/**
 * 三次尝试的间隔：6s → 12s → 20s（累计约 38s）。
 * 首次延迟沿用用户口径 5–8s（取 6s，让宿主服务先就绪），后两次是给「那几秒还没就绪」的重试窗口。
 */
export const AUTORESUME_RETRY_DELAYS_MS = [6_000, 12_000, 20_000] as const
/** 首次延迟（= AUTORESUME_RETRY_DELAYS_MS[0]，保留这个名字给调用方与测试读）。 */
export const AUTORESUME_DELAY_MS = AUTORESUME_RETRY_DELAYS_MS[0]
/** 单次投一条消息是一次宿主调用；10 秒是上限而不是预期耗时（与 NOTIFY_TIMEOUT_MS 同口径）。 */
export const AUTORESUME_TIMEOUT_MS = 10_000

type ReadText = (path: string) => Promise<string>
type WriteAtomic = (path: string, text: string) => Promise<void>
type Log = (line: string) => void

export type AutoResumeDeps = {
  /** 指针文件；缺省 AUTORESUME_PENDING_FILE。 */
  pendingFile?: string
  /** 已确认记录；缺省 AUTORESUME_ACK_FILE。 */
  ackFile?: string
  /** 环境变量表；缺省 process.env（单测注入，避免碰真环境）。 */
  env?: Record<string, string | undefined>
  /** 每次投递时**现解析**宿主服务，不在 apply() 时拍快照（与 installDispatchNotify 同因）。 */
  controllerOf?: () => HostCtx['sessionController']
  /** 跳过与失败都从这里出声，不静默。缺省打到宿主控制台，带插件前缀。 */
  log?: Log
  readText?: ReadText
  writeAtomic?: WriteAtomic
  signal?: AbortSignal
  now?: () => number
  /** 这是第几次尝试（从 1 开始）：只用来写进 ack 的 attempts 与日志，不参与任何判定。 */
  attempt?: number
}

export type AutoResumeOutcome =
  | { status: 'disabled'; reason: string }
  | { status: 'no-pointer'; reason: string }
  | { status: 'written-at-missing'; reason: string }
  | { status: 'already-acked'; writtenAt: string }
  | { status: 'no-target'; reason: string }
  | { status: 'send-failed'; writtenAt: string; sessionId?: string; reason: string; attempts: number; ackError?: string }
  | { status: 'delivered'; writtenAt: string; sessionId: string; attempts: number; ackError?: string }

function reasonOf(error: unknown): string {
  return error instanceof Error ? error.message : String(error)
}

/** 原子写：同目录 tmp + rename（UTF-8 无 BOM），避免半截 ack 被下次启动当成本钱。 */
async function writeAtomicDefault(path: string, text: string): Promise<void> {
  const dir = dirname(path)
  await mkdir(dir, { recursive: true })
  const tmp = `${path}.${process.pid}.tmp`
  await writeFile(tmp, text, 'utf8')
  await rename(tmp, path)
}

/**
 * candidate 是否**严格新于** acked。两个时刻都解析成毫秒再比；
 * 解析不出来（旧格式/手写值）就退回字符串字典序严格大于 —— 不抛、不猜。
 */
export function isStrictlyNewer(candidate: string, acked: string): boolean {
  const fresh = Date.parse(candidate)
  const old = Date.parse(acked)
  if (!Number.isNaN(fresh) && !Number.isNaN(old)) return fresh > old
  return candidate > acked
}

/**
 * 唤醒正文：固定一句话 + 指针的绝对路径。**不抄指针正文** —— 由收到消息的一方自己去读。
 * pid 必须写明是**上一个**宿主：它取自指针里的 host_pid（重启之前那个进程），
 * 收到的人若当成当前 pid 去查会查不到。
 */
export function wakeupText(pointer: { host_pid?: unknown }, pendingFile: string): string {
  const raw = pointer?.host_pid
  const pid = typeof raw === 'number' || typeof raw === 'string' ? String(raw) : '未知'
  return `[重启自检] 宿主已重启（上一个宿主 pid ${pid}）。盘上有接手指针：${pendingFile} —— 先读它再动手，不要凭记忆。`
}

/**
 * 失败也落一份 ack（用户 2026-10-28 审查必改②）：**只写 result / attempts / reason / 时间戳**
 * （外加出错目标的 session_id，否则「会话被删」这类失败在盘上认不出是谁），
 * **绝对不写 written_at** —— isStrictlyNewer 只看 written_at，没有它 ⇒ 下次启动照常重试，
 * 幂等性不受影响；同时失败在盘上留下可见证据，不再只是日志里一行。
 */
async function recordFailure(input: {
  ackFile: string
  writeAtomic: WriteAtomic
  log: Log
  reason: string
  attempts: number
  sessionId?: string
  now: () => number
}): Promise<string | undefined> {
  const record: Record<string, unknown> = {
    result: 'send-failed',
    attempts: input.attempts,
    reason: input.reason,
    attempted_at: new Date(input.now()).toISOString(),
  }
  if (input.sessionId !== undefined && input.sessionId !== '') record.session_id = input.sessionId
  try {
    await input.writeAtomic(input.ackFile, `${JSON.stringify(record, null, 2)}\n`)
    return undefined
  } catch (error) {
    const ackError = reasonOf(error)
    input.log(`startup self-check: the failure record could not be written to ${input.ackFile} (${ackError}); the next start will still try again.`)
    return ackError
  }
}

/** 读 ack 里的 written_at。读不出来/坏 JSON/字段缺失 ⇒ undefined（= 当作还没确认过）。 */
async function readAckedWrittenAt(ackFile: string, readText: ReadText, log: Log): Promise<string | undefined> {
  let text: string
  try {
    text = await readText(ackFile)
  } catch (error) {
    // 第一次跑：没有 ack 文件是正常态，不吵；别的读失败（权限、路径其实是目录）要说一句。
    if ((error as { code?: string } | undefined)?.code !== 'ENOENT') {
      log(`startup self-check: ${ackFile} could not be read (${reasonOf(error)}), so this pointer is treated as not yet confirmed.`)
    }
    return undefined
  }
  let parsed: unknown
  try {
    parsed = JSON.parse(text)
  } catch (error) {
    log(`startup self-check: ${ackFile} is not valid JSON (${reasonOf(error)}), so this pointer is treated as not yet confirmed.`)
    return undefined
  }
  const writtenAt = (parsed as { written_at?: unknown } | null | undefined)?.written_at
  if (typeof writtenAt !== 'string' || writtenAt === '') {
    // 失败记录也走这条路（它故意不带 written_at）—— 这句日志就是「下次会重试」的凭据。
    log(`startup self-check: ${ackFile} has no written_at (a failure record, or an old format), so this pointer is treated as not yet confirmed.`)
    return undefined
  }
  return writtenAt
}

/**
 * 跑一次启动自检（一次尝试）。**任何路径都不抛**：读不到盘、没目标、投不进去都退回一个带原因的 outcome，
 * 由调用方（installAutoResume）决定要不要再排一次重试。
 */
export async function runAutoResume(deps: AutoResumeDeps = {}): Promise<AutoResumeOutcome> {
  const env = deps.env ?? process.env
  const log = deps.log ?? ((line: string) => console.warn(`[dsh-session-create] ${line}`))
  const attempts = Number.isFinite(deps.attempt) && (deps.attempt as number) >= 1 ? Math.trunc(deps.attempt as number) : 1
  // ① 关闭开关：在碰任何文件之前判断（用户判据 6）。
  if (env[AUTORESUME_ENV_FLAG] === '1') {
    const reason = `${AUTORESUME_ENV_FLAG}=1`
    log(`startup self-check skipped (${reason}); no pointer was read.`)
    return { status: 'disabled', reason }
  }

  const pendingFile = deps.pendingFile ?? AUTORESUME_PENDING_FILE
  const ackFile = deps.ackFile ?? AUTORESUME_ACK_FILE
  const readText = deps.readText ?? ((path: string) => readFile(path, 'utf8'))
  const writeAtomic = deps.writeAtomic ?? writeAtomicDefault
  const now = deps.now ?? (() => Date.now())

  // ② 读盘：文件不存在 / JSON 坏 / 不是对象 ⇒ 只记日志、安静退出（fail-open，不猜、不回落默认路径）。
  let pointer: Record<string, unknown>
  try {
    const text = await readText(pendingFile)
    const parsed = JSON.parse(text) as unknown
    if (parsed === null || typeof parsed !== 'object' || Array.isArray(parsed)) {
      const reason = `${pendingFile} is not a JSON object`
      log(`startup self-check: ${reason}; nothing was sent.`)
      return { status: 'no-pointer', reason }
    }
    pointer = parsed as Record<string, unknown>
  } catch (error) {
    const reason = reasonOf(error)
    log(`startup self-check: no usable pointer at ${pendingFile} (${reason}); nothing was sent.`)
    return { status: 'no-pointer', reason }
  }

  const writtenAt = pointer.written_at
  if (typeof writtenAt !== 'string' || writtenAt === '') {
    const reason = `${pendingFile} has no written_at`
    log(`startup self-check: ${reason}, so it cannot be compared with the ack; nothing was sent.`)
    return { status: 'written-at-missing', reason }
  }

  // ③ 幂等：同一份指针（written_at 不严格新于已确认记录）只投一次。
  const acked = await readAckedWrittenAt(ackFile, readText, log)
  if (acked !== undefined && !isStrictlyNewer(writtenAt, acked)) {
    log(`startup self-check: the pointer written at ${writtenAt} was already confirmed (ack ${acked}); nothing was sent.`)
    return { status: 'already-acked', writtenAt }
  }

  // ④ 目标只能是 notify_session_id：缺失或不是字符串 ⇒ 跳过并记日志。不猜主会话、不遍历会话列表。
  const notify = pointer.notify_session_id
  const sessionId = typeof notify === 'string' ? notify.trim() : ''
  if (sessionId === '') {
    const reason = `${pendingFile} has no usable notify_session_id (found ${typeof notify})`
    log(`startup self-check: ${reason}; nothing was sent.`)
    return { status: 'no-target', reason }
  }

  /** 投不进去的统一出口：先落失败 ack（不带 written_at），再返回 send-failed 让上层重试。 */
  const fail = async (reason: string): Promise<AutoResumeOutcome> => {
    log(`startup self-check: attempt ${attempts} did not wake Session "${sessionId}" (${reason}); the pointer stays unconfirmed.`)
    const ackError = await recordFailure({ ackFile, writeAtomic, log, reason, attempts, sessionId, now })
    return { status: 'send-failed', writtenAt, sessionId, reason, attempts, ...(ackError === undefined ? {} : { ackError }) }
  }

  // ⑤ 投递：只走 sessionController.prompt（mode 'queue'），不建会话、不改会话状态。
  const controller = deps.controllerOf?.()
  const text = wakeupText(pointer, pendingFile)
  if (typeof controller?.prompt !== 'function') {
    return await fail('this harness has no sessionController.prompt')
  }
  try {
    const outcome = await controller.prompt(
      {
        requestId: randomUUID(),
        sessionId,
        mode: 'queue',
        content: [{ type: 'text', text }],
      },
      deps.signal ?? AbortSignal.timeout(AUTORESUME_TIMEOUT_MS),
    )
    // 宿主明确回 false = 拒收；其余（true / undefined / 认不出的形状）按已受理处理（与 messageSessionIn 同判据）。
    if (outcome === false) {
      return await fail(`the harness refused the message for Session "${sessionId}"`)
    }
  } catch (error) {
    return await fail(reasonOf(error))
  }

  // ⑥ 投递成功才写「已确认」（先投递后写盘：宿主在两者之间被杀只会导致下次重投一条，不会漏）。
  const deliveredAt = now()
  const ack = {
    written_at: writtenAt,
    host_pid: typeof pointer.host_pid === 'number' || typeof pointer.host_pid === 'string' ? pointer.host_pid : null,
    host_start: pointer.host_start ?? null,
    session_id: sessionId,
    result: 'delivered',
    attempts,
    delivered_at: new Date(deliveredAt).toISOString(),
    pending_file: pendingFile,
    message: text,
  }
  let ackError: string | undefined
  try {
    await writeAtomic(ackFile, `${JSON.stringify(ack, null, 2)}\n`)
  } catch (error) {
    ackError = reasonOf(error)
    log(`startup self-check: delivered to ${sessionId}, but the ack could not be written to ${ackFile} (${ackError}); the next start will deliver once more.`)
  }
  log(`startup self-check: the pointer written at ${writtenAt} woke Session ${sessionId} (attempt ${attempts}).`)
  return { status: 'delivered', writtenAt, sessionId, attempts, ...(ackError === undefined ? {} : { ackError }) }
}

/** 默认调度：延迟执行并 unref —— 不阻塞宿主启动，也不拖宿主的退出。 */
function defaultSchedule(fn: () => void | Promise<unknown>, ms: number): unknown {
  const handle = setTimeout(() => {
    void fn()
  }, ms)
  ;(handle as unknown as { unref?: () => void }).unref?.()
  return handle
}

export type AutoResumeInstallOptions = AutoResumeDeps & {
  /** 首次延迟毫秒；缺省 AUTORESUME_DELAY_MS。单测可传 0 直接跑。 */
  delayMs?: number
  /** 每次尝试的间隔表；缺省 AUTORESUME_RETRY_DELAYS_MS（6s / 12s / 20s）。单测可传 [0,0,0]。 */
  retryDelaysMs?: readonly number[]
  /** 定时器可注入：单测用它验证「注册了、延迟多久、重试序列对不对、有没有崩」。 */
  schedule?: (fn: () => void | Promise<unknown>, ms: number) => unknown
}

/**
 * 在 apply() 里挂上启动自检（最多三次尝试，间隔 6s / 12s / 20s）。
 * **绝不抛错、绝不阻塞宿主启动**：注册失败只写一行日志；每次尝试的整段也包在 catch 里
 * （runAutoResume 内部已逐段兜住，这里是最后一道）。只有 send-failed 才排下一次；
 * 送达、已确认、没指针、没目标都被当成终态，不再重试。
 */
export function installAutoResume(ctx: HostCtx, opts: AutoResumeInstallOptions = {}): void {
  const log = opts.log ?? ((line: string) => console.warn(`[dsh-session-create] ${line}`))
  const env = opts.env ?? process.env
  // 关掉时连定时器都不注册（判据 6：在读取任何文件之前判断）。
  if (env[AUTORESUME_ENV_FLAG] === '1') {
    log(`startup self-check is off (${AUTORESUME_ENV_FLAG}=1); no pointer will be read.`)
    return
  }
  const schedule = opts.schedule ?? defaultSchedule
  const configured = opts.retryDelaysMs ?? AUTORESUME_RETRY_DELAYS_MS
  const delays = configured.filter(ms => Number.isFinite(ms) && ms >= 0)
  if (delays.length === 0) delays.push(AUTORESUME_DELAY_MS)
  if (opts.delayMs !== undefined) delays[0] = opts.delayMs
  const baseDeps: AutoResumeDeps = {
    pendingFile: opts.pendingFile,
    ackFile: opts.ackFile,
    env,
    log,
    readText: opts.readText,
    writeAtomic: opts.writeAtomic,
    signal: opts.signal,
    now: opts.now,
    controllerOf: opts.controllerOf ?? (() => resolveServices(ctx).sessionController),
  }

  const attempt = (index: number): void => {
    if (index >= delays.length) {
      log(`startup self-check gave up after ${delays.length} attempt(s); the pointer stays unconfirmed, so the next host start will try again.`)
      return
    }
    try {
      schedule(() => {
        return runAutoResume({ ...baseDeps, attempt: index + 1 })
          .then((outcome) => {
            if (outcome.status === 'send-failed') attempt(index + 1)
            return outcome
          })
          .catch((error: unknown) => {
            // runAutoResume 自己不该抛；真抛了也不许穿透到宿主，且立刻排下一次（这不算终态）。
            log(`startup self-check crashed (${reasonOf(error)}); the host is unaffected.`)
            attempt(index + 1)
          })
      }, delays[index])
    } catch (error) {
      log(`startup self-check could not be scheduled (${reasonOf(error)}); nothing will be sent.`)
    }
  }

  attempt(0)
}
