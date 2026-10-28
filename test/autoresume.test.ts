// 宿主启动自检投递（2026-10-28）：判据逐条落在这里。
// 默认全程用假 fs / 假 controller，绝不真投；只有最后一条用 .tmp 下的真文件验证原子写与读回。
// 真环境的开关（DSH_AUTORESUME_DISABLE）在 env 里显式给空表，不受外部环境影响。
import { afterAll, beforeAll, describe, expect, test } from 'bun:test'
import { mkdir, readFile as readFileReal, readdir, rm, writeFile as writeFileReal } from 'node:fs/promises'
import { join } from 'node:path'
import {
  AUTORESUME_ACK_FILE,
  AUTORESUME_DELAY_MS,
  AUTORESUME_ENV_FLAG,
  AUTORESUME_PENDING_FILE,
  AUTORESUME_RETRY_DELAYS_MS,
  AUTORESUME_STATE_DIR,
  installAutoResume,
  isStrictlyNewer,
  runAutoResume,
  wakeupText,
  type AutoResumeDeps,
  type AutoResumeInstallOptions,
} from '../src/autoresume'

const PENDING = AUTORESUME_PENDING_FILE
const ACK = AUTORESUME_ACK_FILE
const TMP_ROOT = join(import.meta.dir, '..', '.tmp')

const POINTER = {
  written_at: '2026-10-28T16:31:00+08:00',
  host_pid: 12340,
  host_start: '2026-10-28T16:06:54+08:00',
  reason: '16:06 那次重启已验完：Pocket 三笔 + 插件两件满足装载条件。',
  notify_session_id: 'session-0b2005cc-1006-4887-ab84-8f51d74dabb2',
}

type Fake = {
  files: Map<string, string>
  prompts: Record<string, unknown>[]
  logs: string[]
  reads: string[]
  writes: { path: string; text: string }[]
  deps: AutoResumeDeps
  failPrompts: (times: number) => void
}

/** 假盘 + 假宿主：readText 从 Map 取，writeAtomic 记下内容；prompt 只记录调用。 */
function fake(opts: { pointer?: Record<string, unknown> | string; ack?: Record<string, unknown> | string; env?: Record<string, string | undefined>; noPrompt?: boolean } = {}): Fake {
  const files = new Map<string, string>()
  if (opts.pointer !== undefined) files.set(PENDING, typeof opts.pointer === 'string' ? opts.pointer : JSON.stringify(opts.pointer))
  if (opts.ack !== undefined) files.set(ACK, typeof opts.ack === 'string' ? opts.ack : JSON.stringify(opts.ack))
  const prompts: Record<string, unknown>[] = []
  const logs: string[] = []
  const reads: string[] = []
  const writes: { path: string; text: string }[] = []
  let failures = 0
  const controller = opts.noPrompt === true
    ? {}
    : {
        async prompt(call: Record<string, unknown>) {
          prompts.push(call)
          if (failures > 0) {
            failures -= 1
            throw new Error('the host queue write failed')
          }
          return true
        },
      }
  const deps: AutoResumeDeps = {
    pendingFile: PENDING,
    ackFile: ACK,
    env: opts.env ?? {},
    log: (line: string) => {
      logs.push(line)
    },
    readText: async (path: string) => {
      reads.push(path)
      const text = files.get(path)
      if (text === undefined) throw Object.assign(new Error(`ENOENT: no such file or directory, open '${path}'`), { code: 'ENOENT' })
      return text
    },
    writeAtomic: async (path: string, text: string) => {
      writes.push({ path, text })
      files.set(path, text)
    },
    controllerOf: () => controller as never,
    now: () => Date.parse('2026-10-28T16:40:00+08:00'),
  }
  return { files, prompts, logs, reads, writes, deps, failPrompts: (times: number) => { failures = times } }
}

function textOf(call: Record<string, unknown>): string {
  const content = call.content as { text?: string }[] | undefined
  return content?.[0]?.text ?? ''
}

describe('路径口径', () => {
  test('指针与 ack 都落在 F:\\DSBOT\\state 下，代码里没有 C 盘路径', () => {
    expect(AUTORESUME_STATE_DIR).toBe('F:\\DSBOT\\state')
    expect(PENDING).toBe('F:\\DSBOT\\state\\restart-pending.json')
    expect(ACK).toBe('F:\\DSBOT\\state\\restart-pending.ack.json')
    expect(PENDING.includes('C:')).toBe(false)
    expect(ACK.includes('C:')).toBe(false)
  })

  test('唤醒正文只带「上一个宿主 pid」与指针绝对路径，不抄指针正文，也不让人误认成当前 pid', () => {
    const text = wakeupText(POINTER, PENDING)
    expect(text).toContain('上一个宿主 pid 12340')
    // 不能写成「（pid 12340）」这种会被当成当前宿主 pid 的说法。
    expect(text.includes('（pid')).toBe(false)
    expect(text).toContain(PENDING)
    expect(text).toContain('不要凭记忆')
    expect(text.includes('Pocket 三笔')).toBe(false)
    expect(text.includes('16:06 那次重启已验完')).toBe(false)
    // pid 缺失时不能编一个出来。
    expect(wakeupText({}, PENDING)).toContain('上一个宿主 pid 未知')
  })
})

describe('runAutoResume', () => {
  test('正常：新 written_at ⇒ 投递一次，并把 written_at / host_pid / 投递时间 / 结果写进 ack', async () => {
    const f = fake({ pointer: POINTER })
    const outcome = await runAutoResume(f.deps)

    expect(outcome.status).toBe('delivered')
    expect(f.prompts).toHaveLength(1)
    expect(f.prompts[0].sessionId).toBe(POINTER.notify_session_id)
    expect(f.prompts[0].mode).toBe('queue')
    expect(textOf(f.prompts[0])).toContain(PENDING)
    expect(f.prompts[0].requestId).toBeString()

    expect(f.writes).toHaveLength(1)
    expect(f.writes[0].path).toBe(ACK)
    const ack = JSON.parse(f.writes[0].text) as Record<string, unknown>
    expect(ack.written_at).toBe(POINTER.written_at)
    expect(ack.host_pid).toBe(12340)
    expect(ack.session_id).toBe(POINTER.notify_session_id)
    expect(ack.result).toBe('delivered')
    expect(ack.attempts).toBe(1)
    expect(ack.delivered_at).toBe('2026-10-28T08:40:00.000Z')
    expect(f.logs.some(line => line.includes('woke Session'))).toBe(true)
  })

  test('重复：同一份指针再启动一次 ⇒ 不投递（ack 里已是同一个 written_at）', async () => {
    const f = fake({ pointer: POINTER })
    expect((await runAutoResume(f.deps)).status).toBe('delivered')
    const firstAck = f.writes[0].text

    f.files.set(ACK, firstAck)
    const second = await runAutoResume(f.deps)

    expect(second.status).toBe('already-acked')
    expect(f.prompts).toHaveLength(1)
    expect(f.writes).toHaveLength(1)
    expect(f.logs.some(line => line.includes('already confirmed'))).toBe(true)
  })

  test('写盘口径：ack 不早于指针（更旧的 ack）不算已确认 —— 严格比较而不是「有 ack 就算」', async () => {
    const olderAck = { written_at: '2026-10-28T10:00:00+08:00', host_pid: 9999, result: 'delivered' }
    const f = fake({ pointer: POINTER, ack: olderAck })
    expect((await runAutoResume(f.deps)).status).toBe('delivered')
    expect(f.prompts).toHaveLength(1)
  })

  test('指针文件不存在 ⇒ 不投、不抛', async () => {
    const f = fake({})
    const outcome = await runAutoResume(f.deps)
    expect(outcome.status).toBe('no-pointer')
    expect(f.prompts).toHaveLength(0)
    expect(f.writes).toHaveLength(0)
    expect(f.logs.some(line => line.includes('no usable pointer'))).toBe(true)
  })

  test('指针是坏 JSON ⇒ 不投、不抛', async () => {
    const f = fake({ pointer: '{ not json' })
    const outcome = await runAutoResume(f.deps)
    expect(outcome.status).toBe('no-pointer')
    expect(f.prompts).toHaveLength(0)
    expect(f.logs.length).toBeGreaterThan(0)
  })

  test('written_at 缺失或不是字符串 ⇒ 不投、不抛，并说明原因', async () => {
    for (const pointer of [{ host_pid: 1, notify_session_id: 'session-x' }, { ...POINTER, written_at: 20261028 }]) {
      const f = fake({ pointer })
      const outcome = await runAutoResume(f.deps)
      expect(outcome.status).toBe('written-at-missing')
      expect(f.prompts).toHaveLength(0)
      expect(f.writes).toHaveLength(0)
    }
  })

  test('notify_session_id 缺失或不是字符串 ⇒ 跳过，原因写明，绝不自己猜目标', async () => {
    for (const pointer of [
      { written_at: POINTER.written_at, host_pid: 12340 },
      { written_at: POINTER.written_at, host_pid: 12340, notify_session_id: 12345 },
      { written_at: POINTER.written_at, host_pid: 12340, notify_session_id: '   ' },
    ]) {
      const f = fake({ pointer })
      const outcome = await runAutoResume(f.deps)
      expect(outcome.status).toBe('no-target')
      if (outcome.status === 'no-target') expect(outcome.reason).toContain('notify_session_id')
      expect(f.prompts).toHaveLength(0)
      expect(f.writes).toHaveLength(0)
    }
  })

  test('投递失败（prompt 抛错）⇒ 不抛出、日志有记录、ack 只记失败且**不带 written_at**，下次启动确实重投', async () => {
    const f = fake({ pointer: POINTER })
    f.failPrompts(1)
    const first = await runAutoResume(f.deps)

    expect(first.status).toBe('send-failed')
    if (first.status === 'send-failed') expect(first.attempts).toBe(1)
    expect(f.logs.some(line => line.includes('did not wake Session') && line.includes('stays unconfirmed'))).toBe(true)

    // 必改②：失败也落盘，但那份记录只是证据，不参与幂等判断。
    expect(f.writes).toHaveLength(1)
    expect(f.writes[0].path).toBe(ACK)
    const failure = JSON.parse(f.writes[0].text) as Record<string, unknown>
    expect(failure.result).toBe('send-failed')
    expect(failure.attempts).toBe(1)
    expect(failure.reason).toContain('the host queue write failed')
    expect(failure.session_id).toBe(POINTER.notify_session_id)
    expect(failure.attempted_at).toBe('2026-10-28T08:40:00.000Z')
    // 这条是整条重试链的命门：写了 written_at 就会被下次启动当「已确认」而永久漏掉。
    expect('written_at' in failure).toBe(false)

    // 同一份指针、盘上已有失败记录 ⇒ 下一次启动必须真的还能投。
    const second = await runAutoResume(f.deps)
    expect(second.status).toBe('delivered')
    if (second.status === 'delivered') expect(second.attempts).toBe(1)
    expect(f.prompts).toHaveLength(2)
    expect(f.writes).toHaveLength(2)
    expect((JSON.parse(f.writes[1].text) as Record<string, unknown>).written_at).toBe(POINTER.written_at)
  })

  test('宿主明确拒收（prompt 回 false）⇒ 视为未投递：写失败记录，不写「已确认」', async () => {
    const f = fake({ pointer: POINTER })
    // 用替换 controller 的方式模拟 false。
    const refusing: AutoResumeDeps = {
      ...f.deps,
      controllerOf: () => ({ async prompt() { f.prompts.push({ refused: true }); return false } }) as never,
    }
    const outcome = await runAutoResume(refusing)
    expect(outcome.status).toBe('send-failed')
    expect(f.writes).toHaveLength(1)
    const failure = JSON.parse(f.writes[0].text) as Record<string, unknown>
    expect(failure.result).toBe('send-failed')
    expect(failure.reason).toContain('refused')
    expect('written_at' in failure).toBe(false)
  })

  test('宿主没有 sessionController.prompt ⇒ 跳过，不抛，并在盘上留下失败记录', async () => {
    const f = fake({ pointer: POINTER, noPrompt: true })
    const outcome = await runAutoResume(f.deps)
    expect(outcome.status).toBe('send-failed')
    if (outcome.status === 'send-failed') expect(outcome.reason).toContain('prompt')
    expect(f.prompts).toHaveLength(0)
    expect(f.writes).toHaveLength(1)
    const failure = JSON.parse(f.writes[0].text) as Record<string, unknown>
    expect(failure.result).toBe('send-failed')
    expect(failure.session_id).toBe(POINTER.notify_session_id)
    expect('written_at' in failure).toBe(false)
  })

  test('盘上是一条失败记录（无 written_at）⇒ 当作没确认过，照投', async () => {
    const failure = { result: 'send-failed', attempts: 3, reason: 'the host queue write failed', attempted_at: '2026-10-28T08:40:00.000Z', session_id: POINTER.notify_session_id }
    const f = fake({ pointer: POINTER, ack: failure })
    const outcome = await runAutoResume(f.deps)
    expect(outcome.status).toBe('delivered')
    expect(f.prompts).toHaveLength(1)
    expect(f.logs.some(line => line.includes('has no written_at') && line.includes('not yet confirmed'))).toBe(true)
  })

  test(`${AUTORESUME_ENV_FLAG}=1 ⇒ 连指针都不读，直接跳过`, async () => {
    const f = fake({ pointer: POINTER, env: { [AUTORESUME_ENV_FLAG]: '1' } })
    const outcome = await runAutoResume(f.deps)
    expect(outcome.status).toBe('disabled')
    expect(f.reads).toHaveLength(0)
    expect(f.prompts).toHaveLength(0)
    expect(f.writes).toHaveLength(0)
  })

  test('ack 是坏 JSON ⇒ 按「还没确认过」照投一次（宁可多叫醒，不可漏叫醒）', async () => {
    const f = fake({ pointer: POINTER, ack: '{ broken' })
    const outcome = await runAutoResume(f.deps)
    expect(outcome.status).toBe('delivered')
    expect(f.prompts).toHaveLength(1)
    expect(f.logs.some(line => line.includes('not valid JSON'))).toBe(true)
  })
})

describe('installAutoResume', () => {
  test('注册延迟检查：首跳延迟 AUTORESUME_DELAY_MS，到点才投，且不阻塞 apply', async () => {
    const f = fake({ pointer: POINTER })
    const scheduled: { ms: number; fn: () => void | Promise<unknown> }[] = []
    const options: AutoResumeInstallOptions = {
      ...f.deps,
      schedule: (fn, ms) => {
        scheduled.push({ ms, fn })
        return 1
      },
    }
    const ctx = { sessionController: { async prompt() { return true } } }
    installAutoResume(ctx as never, options)

    expect(scheduled).toHaveLength(1)
    expect(scheduled[0].ms).toBe(AUTORESUME_DELAY_MS)
    expect(f.prompts).toHaveLength(0) // 注册那一刻什么都没发生 = 不阻塞宿主启动

    await scheduled[0].fn()
    expect(f.prompts).toHaveLength(1)
    expect(f.writes).toHaveLength(1)
    expect(scheduled).toHaveLength(1) // 投成功了，不该再排第二跳
  })

  test('必改①：投不进去就按 6s / 12s / 20s 重试三次，第三次仍失败才落 send-failed', async () => {
    const f = fake({ pointer: POINTER })
    f.failPrompts(3)
    const scheduled: { ms: number; fn: () => void | Promise<unknown> }[] = []
    installAutoResume({} as never, {
      ...f.deps,
      schedule: (fn, ms) => {
        scheduled.push({ ms, fn })
        return 1
      },
    })

    expect(scheduled.map(item => item.ms)).toEqual([6_000]) // 首跳先注册，后面每次失败才排下一跳
    await scheduled[0].fn()
    expect(scheduled.map(item => item.ms)).toEqual([6_000, 12_000])
    await scheduled[1].fn()
    expect(scheduled.map(item => item.ms)).toEqual([6_000, 12_000, 20_000])
    await scheduled[2].fn()

    expect(scheduled).toHaveLength(3) // 没有第四跳
    expect(scheduled.map(item => item.ms)).toEqual([...AUTORESUME_RETRY_DELAYS_MS])
    expect(f.prompts).toHaveLength(3)
    expect(f.writes).toHaveLength(3)
    const last = JSON.parse(f.writes[f.writes.length - 1].text) as Record<string, unknown>
    expect(last.result).toBe('send-failed')
    expect(last.attempts).toBe(3)
    expect('written_at' in last).toBe(false) // 三轮全失败也不写「已确认」
    expect(f.logs.some(line => line.includes('gave up after 3 attempt'))).toBe(true)
  })

  test('必改①：中途投进去了就立刻停，不再排后续尝试（attempts 记进 ack）', async () => {
    const f = fake({ pointer: POINTER })
    f.failPrompts(1) // 第一次失败，第二次成功
    const scheduled: { ms: number; fn: () => void | Promise<unknown> }[] = []
    installAutoResume({} as never, {
      ...f.deps,
      schedule: (fn, ms) => {
        scheduled.push({ ms, fn })
        return 1
      },
    })

    await scheduled[0].fn()
    expect(scheduled).toHaveLength(2)
    await scheduled[1].fn()
    expect(scheduled).toHaveLength(2) // 成功即终态，不再排第三跳
    expect(f.prompts).toHaveLength(2)
    const last = JSON.parse(f.writes[f.writes.length - 1].text) as Record<string, unknown>
    expect(last.result).toBe('delivered')
    expect(last.attempts).toBe(2)
    expect(last.written_at).toBe(POINTER.written_at)
  })

  test('必改①：已确认 / 没指针 / 没目标都是终态，不重试（只投一次的机会都不给第二次）', async () => {
    const cases: Parameters<typeof fake>[0][] = [
      { pointer: POINTER, ack: { written_at: POINTER.written_at, result: 'delivered' } },
      {}, // 盘上没有指针
      { pointer: { written_at: POINTER.written_at, host_pid: 12340 } }, // 没有 notify_session_id
      { pointer: { host_pid: 12340, notify_session_id: POINTER.notify_session_id } }, // 没有 written_at
    ]
    for (const options of cases) {
      const f = fake(options)
      const scheduled: { ms: number; fn: () => void | Promise<unknown> }[] = []
      installAutoResume({} as never, {
        ...f.deps,
        schedule: (fn, ms) => {
          scheduled.push({ ms, fn })
          return 1
        },
      })
      expect(scheduled).toHaveLength(1)
      await scheduled[0].fn()
      expect(scheduled).toHaveLength(1)
      expect(f.prompts).toHaveLength(0)
    }
  })

  test('间隔表可注入（retryDelaysMs），delayMs 只覆盖首跳', async () => {
    const f = fake({ pointer: POINTER })
    f.failPrompts(3)
    const scheduled: { ms: number; fn: () => void | Promise<unknown> }[] = []
    installAutoResume({} as never, {
      ...f.deps,
      retryDelaysMs: [10, 20, 30],
      delayMs: 0,
      schedule: (fn, ms) => {
        scheduled.push({ ms, fn })
        return 1
      },
    })
    expect(scheduled[0].ms).toBe(0)
    await scheduled[0].fn()
    await scheduled[1].fn()
    expect(scheduled.map(item => item.ms)).toEqual([0, 20, 30])
    await scheduled[2].fn()
    expect(f.prompts).toHaveLength(3)
  })

  test('定时器注册本身抛错 ⇒ installAutoResume 不抛，只记日志', () => {
    const f = fake({ pointer: POINTER })
    const logs: string[] = []
    const options: AutoResumeInstallOptions = {
      ...f.deps,
      log: (line: string) => { logs.push(line) },
      schedule: () => { throw new Error('timer registration refused') },
    }
    expect(() => installAutoResume({} as never, options)).not.toThrow()
    expect(logs.some(line => line.includes('could not be scheduled'))).toBe(true)
  })

  test(`${AUTORESUME_ENV_FLAG}=1 ⇒ 连定时器都不注册`, () => {
    const f = fake({ pointer: POINTER })
    const scheduled: unknown[] = []
    const options: AutoResumeInstallOptions = {
      ...f.deps,
      env: { [AUTORESUME_ENV_FLAG]: '1' },
      schedule: (fn, ms) => { scheduled.push([fn, ms]); return 1 },
    }
    installAutoResume({} as never, options)
    expect(scheduled).toHaveLength(0)
  })
})

describe('isStrictlyNewer', () => {
  test('按时间比较（含时区），不可解析时退回字符串严格大于', () => {
    expect(isStrictlyNewer('2026-10-28T16:31:00+08:00', '2026-10-28T16:30:00+08:00')).toBe(true)
    expect(isStrictlyNewer('2026-10-28T08:31:00Z', '2026-10-28T16:31:00+08:00')).toBe(false)
    expect(isStrictlyNewer('2026-10-28T16:31:00+08:00', '2026-10-28T16:31:00+08:00')).toBe(false)
    expect(isStrictlyNewer('v2', 'v1')).toBe(true)
    expect(isStrictlyNewer('v1', 'v1')).toBe(false)
  })
})

describe('真写盘（默认原子写）', () => {
  const dir = join(TMP_ROOT, 'autoresume-real')

  beforeAll(async () => {
    await mkdir(dir, { recursive: true })
  })

  afterAll(async () => {
    // 自测自清：只删本测试建的目录。
    await rm(dir, { recursive: true, force: true })
  })

  test('ack 真的落到盘上：UTF-8 无 BOM、可 JSON.parse、tmp 文件不残留', async () => {
    const pendingFile = join(dir, 'restart-pending.json')
    const ackFile = join(dir, 'restart-pending.ack.json')
    await writeFileReal(pendingFile, JSON.stringify(POINTER), 'utf8')

    const prompts: Record<string, unknown>[] = []
    const outcome = await runAutoResume({
      pendingFile,
      ackFile,
      env: {},
      log: () => {},
      controllerOf: () => ({ async prompt(call: Record<string, unknown>) { prompts.push(call); return true } }) as never,
    })

    expect(outcome.status).toBe('delivered')
    expect(prompts).toHaveLength(1)
    const raw = await readFileReal(ackFile, 'utf8')
    expect(raw.charCodeAt(0)).not.toBe(0xfeff)
    const ack = JSON.parse(raw) as Record<string, unknown>
    expect(ack.written_at).toBe(POINTER.written_at)
    expect(ack.session_id).toBe(POINTER.notify_session_id)
    // 再跑一次：盘上的 ack 生效，不再投。
    const again = await runAutoResume({
      pendingFile,
      ackFile,
      env: {},
      log: () => {},
      controllerOf: () => ({ async prompt(call: Record<string, unknown>) { prompts.push(call); return true } }) as never,
    })
    expect(again.status).toBe('already-acked')
    expect(prompts).toHaveLength(1)
    // 原子写不留 tmp 残件：目录里只有指针与 ack 两个文件。
    const entries = (await readdir(dir)).sort()
    expect(entries).toEqual(['restart-pending.ack.json', 'restart-pending.json'])
  })

  test('真盘自查：投递失败把失败记录写进真文件后，下一次启动确实会重投，成功后才写「已确认」', async () => {
    const dir2 = join(TMP_ROOT, 'autoresume-retry-real')
    await mkdir(dir2, { recursive: true })
    try {
      const pendingFile = join(dir2, 'restart-pending.json')
      const ackFile = join(dir2, 'restart-pending.ack.json')
      await writeFileReal(pendingFile, JSON.stringify(POINTER), 'utf8')

      const failing = await runAutoResume({
        pendingFile,
        ackFile,
        env: {},
        log: () => {},
        attempt: 1,
        controllerOf: () => ({ async prompt() { throw new Error('the host queue write failed') } }) as never,
      })
      expect(failing.status).toBe('send-failed')

      const rawFailure = await readFileReal(ackFile, 'utf8')
      expect(rawFailure.charCodeAt(0)).not.toBe(0xfeff)
      const failure = JSON.parse(rawFailure) as Record<string, unknown>
      expect(failure.result).toBe('send-failed')
      expect(failure.attempts).toBe(1)
      expect('written_at' in failure).toBe(false)

      // 同一份真盘：下一次启动（第 2 次尝试）必须真的再投一次，而不是被失败记录挡在 already-acked。
      const prompts: Record<string, unknown>[] = []
      const second = await runAutoResume({
        pendingFile,
        ackFile,
        env: {},
        log: () => {},
        attempt: 2,
        controllerOf: () => ({ async prompt(call: Record<string, unknown>) { prompts.push(call); return true } }) as never,
      })
      expect(second.status).toBe('delivered')
      if (second.status === 'delivered') expect(second.attempts).toBe(2)
      expect(prompts).toHaveLength(1)

      const delivered = JSON.parse(await readFileReal(ackFile, 'utf8')) as Record<string, unknown>
      expect(delivered.result).toBe('delivered')
      expect(delivered.written_at).toBe(POINTER.written_at)
      expect(delivered.attempts).toBe(2)

      // 第三次启动：这次该被「已确认」挡住，不再投。
      const third = await runAutoResume({
        pendingFile,
        ackFile,
        env: {},
        log: () => {},
        attempt: 1,
        controllerOf: () => ({ async prompt() { throw new Error('should not be called') } }) as never,
      })
      expect(third.status).toBe('already-acked')
      // 失败记录与成功记录都走原子写，目录里不许留 tmp 残件。
      expect((await readdir(dir2)).sort()).toEqual(['restart-pending.ack.json', 'restart-pending.json'])
    } finally {
      await rm(dir2, { recursive: true, force: true })
    }
  })
})
