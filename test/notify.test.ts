// 完成回执（2026-10-28）：派出去的会话安静下来后，主动把一条短回执投回派活人的会话。
// 这里直接测 src/core.ts 的 createDispatchNotifier（注入假定时器，把 120 秒窗口变成确定的一步），
// 末尾一段测构建产物 index.js 的接线——那一段跑前要先 `bun run build`（与 plugin.test.ts 同口径）。
import { afterAll, beforeAll, describe, expect, test } from 'bun:test'
import { mkdir, readdir, rm } from 'node:fs/promises'
import { join } from 'node:path'
import {
  QUIET_WINDOW_MS,
  appendDispatch,
  createDispatchNotifier,
  installDispatchNotify,
  readLedger,
  receiptText,
  type DispatchRecord,
  type HostCtx,
} from '../src/core'
import { apply as applyBuilt } from '../index.js'

const TMP_ROOT = join(import.meta.dir, '..', '.tmp')
const previousAutoResume = process.env.DSH_AUTORESUME_DISABLE

type Timer = { ms: number; fn: () => void | Promise<void>; cancelled: boolean }

type Scenario = {
  /** 目标会话在宿主那里报的状态（缺省 'idle'）。 */
  status?: unknown
  /** 派活方会话已被销毁（resolveAgent 返回 error）。 */
  dispatcherGone?: boolean
  /** 宿主拒收这条提示词。 */
  promptThrows?: boolean
}

function ledgerFor(name: string): string {
  return join(TMP_ROOT, `notify-${name}.jsonl`)
}

/** 一条台账记录：默认是本插件派出去、且记着派活人的形态。 */
async function seed(ledgerPath: string, overrides: Partial<DispatchRecord> = {}): Promise<DispatchRecord> {
  const record: DispatchRecord = {
    sessionId: 'sess-1',
    title: '投标跟进',
    placement: 'workspace ws-1 (投标)',
    dispatchedAt: 1_000_000,
    promptHead: '接着做投标第三章',
    dispatcherSessionId: 'chief-1',
    ...overrides,
  }
  await appendDispatch(ledgerPath, record)
  return record
}

function harness(name: string, scenario: Scenario = {}) {
  const ledgerPath = ledgerFor(name)
  const timers: Timer[] = []
  const prompts: Record<string, unknown>[] = []
  const resolvedIds: string[] = []
  const logs: string[] = []
  let clock = 2_000_000

  const controller = {
    async resolveAgent(sessionId: string) {
      resolvedIds.push(sessionId)
      if (sessionId === 'chief-1' && scenario.dispatcherGone === true) return { error: { message: 'no such Session' } }
      const status = sessionId === 'chief-1' ? 'running' : ('status' in scenario ? scenario.status : 'idle')
      return { agent: { session: { id: sessionId, seq: 1 }, status } }
    },
    async prompt(options: Record<string, unknown>) {
      if (scenario.promptThrows === true) throw new Error('the host refused the prompt')
      prompts.push(options)
      return true
    },
  }

  const notifier = createDispatchNotifier({
    ledger: ledgerPath,
    controllerOf: () => controller as unknown as HostCtx['sessionController'],
    now: () => clock,
    setTimer: (fn, ms) => {
      const timer: Timer = { ms, fn, cancelled: false }
      timers.push(timer)
      return timer
    },
    clearTimer: handle => {
      ;(handle as Timer).cancelled = true
    },
    log: line => {
      logs.push(line)
    },
  })

  return {
    ledgerPath,
    notifier,
    timers,
    prompts,
    resolvedIds,
    logs,
    controller,
    /** 时间往前走（真实场景里下一轮的 endTime 必然晚于上次投递时刻）。 */
    tick: (ms: number) => {
      clock += ms
    },
    clock: () => clock,
  }
}

async function fire(timer: Timer | undefined): Promise<void> {
  if (timer === undefined) throw new Error('no timer was set')
  if (timer.cancelled) throw new Error('this timer was cancelled')
  await timer.fn()
}

async function endTurn(notifier: ReturnType<typeof harness>['notifier'], turn: number, kind = 'stop'): Promise<void> {
  await notifier.onEvent({ id: 'sess-1' }, { type: 'turn/end', data: { turn, reason: { kind } } })
}

beforeAll(async () => {
  await mkdir(TMP_ROOT, { recursive: true })
  // 末尾「构建产物」那一段会调 apply()；启动自检默认延迟 6 秒读真盘并投真会话，这里整段关掉。
  process.env.DSH_AUTORESUME_DISABLE = '1'
})

afterAll(async () => {
  if (previousAutoResume === undefined) delete process.env.DSH_AUTORESUME_DISABLE
  else process.env.DSH_AUTORESUME_DISABLE = previousAutoResume
  // 自测自清：只删本文件建的台账。
  const entries = await readdir(TMP_ROOT).catch(() => [] as string[])
  await Promise.all(
    entries.filter(entry => entry.startsWith('notify-')).map(entry => rm(join(TMP_ROOT, entry), { force: true, recursive: true })),
  )
})

describe('完成回执：投递通道与正文', () => {
  test('安静到点后，用 controller.prompt(queue) 把短回执投给派活方，首行带标题', async () => {
    const h = harness('delivers')
    await seed(h.ledgerPath)
    await h.notifier.onEvent({ id: 'sess-1' }, { type: 'turn/start', data: { turn: 1 } })
    await endTurn(h.notifier, 1)

    // 到点之前什么都不发：先等满一个静默窗口。
    expect(h.prompts).toHaveLength(0)
    expect(h.notifier.pending().map(entry => entry.sessionId)).toEqual(['sess-1'])
    expect(h.timers).toHaveLength(1)
    expect(h.timers[0].ms).toBe(QUIET_WINDOW_MS)

    h.tick(QUIET_WINDOW_MS)
    await fire(h.timers[0])

    expect(h.prompts).toHaveLength(1)
    expect(h.prompts[0].sessionId).toBe('chief-1')
    expect(h.prompts[0].mode).toBe('queue')
    expect(typeof h.prompts[0].requestId).toBe('string')
    const text = (h.prompts[0].content as { type: string; text: string }[])[0].text
    expect(text.split('\n')[0]).toBe('[Dispatch receipt · 投标跟进]')
    expect(text).toContain('sess-1')
    expect(text).toContain('turn 1')
    expect(text).toContain('reason: stop')
    // 复核顺序：先向宿主核目标会话是否真的空闲，再核派活方还在不在。
    expect(h.resolvedIds).toEqual(['sess-1', 'chief-1'])
    // 静默期结束、台账留痕。
    expect(h.notifier.pending()).toEqual([])
    expect(typeof (await readLedger(h.ledgerPath))[0].notifiedAt).toBe('number')
  })

  test('回执正文只写：标题、sessionId、结束时间、轮次、最后一轮的 reason', () => {
    const text = receiptText({ title: '投标跟进' }, 'sess-9', 1_769_000_000_000, 3, 'stop')
    const lines = text.split('\n')
    expect(lines).toHaveLength(3)
    expect(lines[0]).toBe('[Dispatch receipt · 投标跟进]')
    expect(lines[1]).toContain('sess-9')
    expect(lines[1]).toContain('turn 3')
    expect(lines[1]).toContain('reason: stop')
    expect(lines[1]).toContain('2026-')
    expect(lines[2]).toContain('read_session_transcript')
    // 标题与轮次缺失时也要能写出话，不许出现 undefined。
    const bare = receiptText({}, 'sess-9', 0)
    expect(bare.split('\n')[0]).toBe('[Dispatch receipt · (untitled)]')
    expect(bare).not.toContain('undefined')
  })
})

describe('完成回执：两道假回执门', () => {
  test('门一：turn/end 是关停或叫停（aborted）时不发回执', async () => {
    const h = harness('aborted')
    await seed(h.ledgerPath)
    await h.notifier.onEvent({ id: 'sess-1' }, { type: 'turn/start', data: { turn: 1 } })
    await endTurn(h.notifier, 1, 'aborted')
    expect(h.timers).toHaveLength(0)
    expect(h.notifier.pending()).toEqual([])
    expect(h.prompts).toHaveLength(0)
  })

  test('门二：到点后宿主说它仍在跑（status=running）→ 不投', async () => {
    const h = harness('busy', { status: 'running' })
    await seed(h.ledgerPath)
    await endTurn(h.notifier, 2)
    await fire(h.timers[0])
    expect(h.prompts).toHaveLength(0)
    expect(h.logs.some(line => line.includes('does not report it idle'))).toBe(true)
  })

  test('门二：认不出的状态（undefined）也不投——只认 idle', async () => {
    const h = harness('unknown-status', { status: undefined })
    await seed(h.ledgerPath)
    await endTurn(h.notifier, 2)
    await fire(h.timers[0])
    expect(h.prompts).toHaveLength(0)
    expect(h.logs.some(line => line.includes('status=undefined'))).toBe(true)
  })
})

describe('完成回执：只认台账里本插件派出去的会话', () => {
  test('台账外的会话（Bot 会话、别人开的会话）一个事件都不处理', async () => {
    const h = harness('whitelist')
    await seed(h.ledgerPath)
    await h.notifier.onEvent({ id: 'bot-7' }, { type: 'turn/start', data: { turn: 1 } })
    await h.notifier.onEvent({ id: 'bot-7' }, { type: 'turn/end', data: { turn: 1, reason: { kind: 'stop' } } })
    expect(h.timers).toHaveLength(0)
    expect(h.notifier.pending()).toEqual([])
    expect(h.prompts).toHaveLength(0)
  })

  test('不是 turn/start、turn/end 的事件直接忽略', async () => {
    const h = harness('other-events')
    await seed(h.ledgerPath)
    await h.notifier.onEvent({ id: 'sess-1' }, { type: 'message/added' })
    await h.notifier.onEvent(undefined, { type: 'turn/end' })
    expect(h.timers).toHaveLength(0)
  })

  test('台账读不出来时如实出声，且不发（白名单判不了就不投）', async () => {
    const dirAsLedger = join(TMP_ROOT, 'notify-dir-as-ledger')
    await mkdir(dirAsLedger, { recursive: true })
    const logs: string[] = []
    const prompts: unknown[] = []
    const notifier = createDispatchNotifier({
      ledger: dirAsLedger,
      controllerOf: () => ({ resolveAgent: async () => ({ agent: { status: 'idle' } }), prompt: async () => true }) as never,
      setTimer: () => ({}),
      clearTimer: () => {},
      log: line => logs.push(line),
    })
    await endTurn(notifier, 1)
    expect(prompts).toHaveLength(0)
    expect(logs.some(line => line.includes('could not be read'))).toBe(true)
  })
})

describe('完成回执：防刷屏', () => {
  test('静默合并：一轮结束又来一轮，旧的静默期作废，只在最后安静下来时投一条', async () => {
    const h = harness('merge')
    await seed(h.ledgerPath)
    await endTurn(h.notifier, 1)
    expect(h.timers).toHaveLength(1)
    await h.notifier.onEvent({ id: 'sess-1' }, { type: 'turn/start', data: { turn: 2 } })
    expect(h.timers[0].cancelled).toBe(true)
    expect(h.notifier.pending()).toEqual([])
    await endTurn(h.notifier, 2)
    expect(h.timers).toHaveLength(2)
    h.tick(QUIET_WINDOW_MS)
    await fire(h.timers[1])
    expect(h.prompts).toHaveLength(1)
  })

  test('幂等①（同一实例）：同一段静默期只投一次', async () => {
    const h = harness('idempotent-once')
    await seed(h.ledgerPath)
    await endTurn(h.notifier, 1)
    await fire(h.timers[0])
    await fire(h.timers[0])
    expect(h.prompts).toHaveLength(1)
  })

  test('幂等②（跨实例/重启）：台账上 notifiedAt 已覆盖这一段静默期，就不再投', async () => {
    const h = harness('idempotent-second-instance')
    await seed(h.ledgerPath)
    await endTurn(h.notifier, 1)
    await fire(h.timers[0])
    expect(h.prompts).toHaveLength(1)

    // 新实例：内存里没有「投过」的记忆，只剩台账。
    const timers: Timer[] = []
    const second = createDispatchNotifier({
      ledger: h.ledgerPath,
      controllerOf: () => h.controller as unknown as HostCtx['sessionController'],
      now: h.clock,
      setTimer: (fn, ms) => {
        const timer: Timer = { ms, fn, cancelled: false }
        timers.push(timer)
        return timer
      },
      clearTimer: handle => {
        ;(handle as Timer).cancelled = true
      },
      log: () => {},
    })
    await endTurn(second, 1)
    await fire(timers[0])
    expect(h.prompts).toHaveLength(1)
  })

  test('新一轮跑完可以再投一条（turn/start 清掉「已投过」）', async () => {
    const h = harness('next-turn')
    await seed(h.ledgerPath)
    await endTurn(h.notifier, 1)
    h.tick(QUIET_WINDOW_MS)
    await fire(h.timers[0])
    expect(h.prompts).toHaveLength(1)

    await h.notifier.onEvent({ id: 'sess-1' }, { type: 'turn/start', data: { turn: 2 } })
    h.tick(60_000)
    await endTurn(h.notifier, 2)
    h.tick(QUIET_WINDOW_MS)
    await fire(h.timers[1])
    expect(h.prompts).toHaveLength(2)
  })
})

describe('完成回执：投不出去的情形都不许抛', () => {
  test('派活方会话已销毁 → 跳过，不投、不记 notifiedAt', async () => {
    const h = harness('dispatcher-gone', { dispatcherGone: true })
    await seed(h.ledgerPath)
    await endTurn(h.notifier, 1)
    await fire(h.timers[0])
    expect(h.prompts).toHaveLength(0)
    expect(h.logs.some(line => line.includes('is gone'))).toBe(true)
    expect((await readLedger(h.ledgerPath))[0].notifiedAt).toBeUndefined()
  })

  test('台账行没有 dispatcherSessionId（这功能之前派的老单）→ 不发', async () => {
    const h = harness('no-dispatcher')
    await seed(h.ledgerPath, { dispatcherSessionId: undefined })
    await endTurn(h.notifier, 1)
    await fire(h.timers[0])
    expect(h.prompts).toHaveLength(0)
    expect(h.logs.some(line => line.includes('no dispatcherSessionId'))).toBe(true)
  })

  test('宿主拒收提示词 → 只出声，不记 notifiedAt（下一轮结束时还能再试）', async () => {
    const h = harness('prompt-throws', { promptThrows: true })
    await seed(h.ledgerPath)
    await endTurn(h.notifier, 1)
    await fire(h.timers[0])
    expect(h.prompts).toHaveLength(0)
    expect(h.logs.some(line => line.includes('did not go through'))).toBe(true)
    expect((await readLedger(h.ledgerPath))[0].notifiedAt).toBeUndefined()
  })

  test('宿主没有 sessionController.resolveAgent/prompt → 如实出声，不炸', async () => {
    const ledgerPath = ledgerFor('no-controller')
    await seed(ledgerPath)
    const logs: string[] = []
    const timers: Timer[] = []
    const notifier = createDispatchNotifier({
      ledger: ledgerPath,
      controllerOf: () => undefined,
      setTimer: (fn, ms) => {
        const timer: Timer = { ms, fn, cancelled: false }
        timers.push(timer)
        return timer
      },
      clearTimer: () => {},
      log: line => logs.push(line),
    })
    await endTurn(notifier, 1)
    await fire(timers[0])
    expect(logs.some(line => line.includes('no sessionController.resolveAgent/prompt'))).toBe(true)
  })
})

describe('完成回执：接线', () => {
  test('installDispatchNotify：宿主没有 on 时如实报一句并返回 undefined（其余工具照常）', () => {
    const warns: unknown[][] = []
    const original = console.warn
    console.warn = (...args: unknown[]) => {
      warns.push(args)
    }
    try {
      expect(installDispatchNotify({} as HostCtx)).toBeUndefined()
    } finally {
      console.warn = original
    }
    expect(warns.some(args => String(args[0]).includes('no `on`'))).toBe(true)
  })

  test('installDispatchNotify：挂上 session/event，到点真的投一条（真定时器，窗口压到 1ms）', async () => {
    const ledgerPath = ledgerFor('installed')
    await seed(ledgerPath)
    const prompts: Record<string, unknown>[] = []
    const handlers: { name: string; handler: (session: unknown, event: unknown) => void }[] = []
    const controller = {
      async resolveAgent(sessionId: string) {
        return { agent: { session: { id: sessionId, seq: 1 }, status: sessionId === 'chief-1' ? 'running' : 'idle' } }
      },
      async prompt(options: Record<string, unknown>) {
        prompts.push(options)
        return true
      },
    }
    const ctx = {
      sessionController: controller,
      on: (name: string, handler: (session: unknown, event: unknown) => void) => {
        handlers.push({ name, handler })
      },
    } as unknown as HostCtx

    const notifier = installDispatchNotify(ctx, { ledger: ledgerPath, quietMs: 1 })
    expect(notifier).toBeDefined()
    expect(handlers).toHaveLength(1)
    expect(handlers[0].name).toBe('session/event')

    await handlers[0].handler({ id: 'sess-1' }, { type: 'turn/end', data: { turn: 3, reason: { kind: 'stop' } } })
    // 监听器是 fire-and-forget（宿主事件面没人接返回值），只能等窗口到点后再断言投递结果。
    await new Promise(resolve => setTimeout(resolve, 50))
    expect(prompts).toHaveLength(1)
    expect((prompts[0].content as { text: string }[])[0].text).toContain('turn 3')
  })

  test('构建产物：create_session 把派活人的会话 id 记进台账，并把回执监听挂上 ctx', async () => {
    const ledgerPath = ledgerFor('built')
    const previous = process.env.DSH_SESSION_CREATE_LEDGER
    try {
      process.env.DSH_SESSION_CREATE_LEDGER = ledgerPath
      const tools = new Map<string, { execute: (args: Record<string, unknown>, exec?: unknown) => Promise<string> }>()
      const events: string[] = []
      const services = {
        tools: { register: (tool: { name: string }) => { tools.set(tool.name, tool as never) } },
        sessionController: {
          async create() { return { sessionId: 'sess-built' } },
          async prompt() { return true },
          async resolveAgent(sessionId: string) { return { agent: { session: { id: sessionId, seq: 1 }, status: 'idle' } } },
        },
        sessionTitle: { async rename() {} },
        workspaceRegistry: {
          get: () => ({ id: 'ws-1', title: '投标' }),
          async archiveSession() {},
        },
      }
      const ctx = {
        ...services,
        get: (name: string) => (services as Record<string, unknown>)[name],
        on: (name: string) => { events.push(name) },
      }
      applyBuilt(ctx as never)
      expect(events).toEqual(['session/event'])

      const spec = tools.get('create_session')
      if (spec === undefined) throw new Error('apply() registered no create_session tool')
      const text = await spec.execute(
        { title: '复核单', prompt: '跑一下第三章', workspace: 'ws-1' },
        { agent: { session: { id: 'chief-1' } } },
      )
      expect(text).toContain('sess-built')
      expect((await readLedger(ledgerPath))[0].dispatcherSessionId).toBe('chief-1')
    } finally {
      if (previous === undefined) delete process.env.DSH_SESSION_CREATE_LEDGER
      else process.env.DSH_SESSION_CREATE_LEDGER = previous
    }
  })
})
