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

  test('唤醒正文只带 pid 与指针绝对路径，不抄指针正文', () => {
    const text = wakeupText(POINTER, PENDING)
    expect(text).toContain('pid 12340')
    expect(text).toContain(PENDING)
    expect(text).toContain('不要凭记忆')
    expect(text.includes('Pocket 三笔')).toBe(false)
    expect(text.includes('16:06 那次重启已验完')).toBe(false)
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

  test('投递失败（prompt 抛错）⇒ 不抛出、日志有记录、不写「已确认」，下次启动还能重试', async () => {
    const f = fake({ pointer: POINTER })
    f.failPrompts(1)
    const first = await runAutoResume(f.deps)

    expect(first.status).toBe('send-failed')
    expect(f.writes).toHaveLength(0)
    expect(f.files.has(ACK)).toBe(false)
    expect(f.logs.some(line => line.includes('did not go into Session') && line.includes('next start will try again'))).toBe(true)

    // 同一份指针、同一份盘：下一次启动必须真的还能投。
    const second = await runAutoResume(f.deps)
    expect(second.status).toBe('delivered')
    expect(f.prompts).toHaveLength(2)
    expect(f.writes).toHaveLength(1)
  })

  test('宿主明确拒收（prompt 回 false）⇒ 视为未投递，不写 ack', async () => {
    const f = fake({ pointer: POINTER })
    // 用替换 controller 的方式模拟 false。
    const refusing: AutoResumeDeps = {
      ...f.deps,
      controllerOf: () => ({ async prompt() { f.prompts.push({ refused: true }); return false } }) as never,
    }
    const outcome = await runAutoResume(refusing)
    expect(outcome.status).toBe('send-failed')
    expect(f.writes).toHaveLength(0)
  })

  test('宿主没有 sessionController.prompt ⇒ 跳过，不抛', async () => {
    const f = fake({ pointer: POINTER, noPrompt: true })
    const outcome = await runAutoResume(f.deps)
    expect(outcome.status).toBe('send-failed')
    if (outcome.status === 'send-failed') expect(outcome.reason).toContain('prompt')
    expect(f.writes).toHaveLength(0)
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
  test('注册一次性延迟检查：延迟 AUTORESUME_DELAY_MS，到点才投，且不阻塞 apply', async () => {
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
})
