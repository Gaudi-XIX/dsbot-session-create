// 完成回执（2026-10-28）：派出去的会话安静下来后，主动把一条短回执投回派活人的会话。
// 这里直接测 src/core.ts 的 createDispatchNotifier（注入假定时器，把 120 秒窗口变成确定的一步），
// 末尾一段测构建产物 index.js 的接线——那一段跑前要先 `bun run build`（与 plugin.test.ts 同口径）。
import { afterAll, beforeAll, describe, expect, test } from 'bun:test'
import { mkdir, readdir, rm } from 'node:fs/promises'
import { join } from 'node:path'
import {
  CONCLUSION_LINE_CLIP,
  QUIET_WINDOW_MS,
  TERMINAL_MARKS,
  appendDispatch,
  createDispatchNotifier,
  installDispatchNotify,
  readLedger,
  receiptText,
  suggestDeadlineSeconds,
  terminalMarkOf,
  type DispatchRecord,
  type HostCtx,
} from '../src/core'
import { RECEIPT_BACKOFF_MS, RECEIPT_MAX_ATTEMPTS, enqueueEntry, readOutbox, receiptIdOf, writeOutbox } from '../src/outbox'
import { apply as applyBuilt } from '../index.js'

const TMP_ROOT = join(import.meta.dir, '..', '.tmp')
const previousAutoResume = process.env.DSH_AUTORESUME_DISABLE

type Timer = { ms: number; fn: () => void | Promise<void>; cancelled: boolean }

type Scenario = {
  /** 目标会话在宿主那里报的状态（缺省 'idle'）。 */
  status?: unknown
  /** 按会话 id 单独指定状态；给了就以它为准（用来造「子会话还在跑」的场面）。 */
  statuses?: Record<string, unknown>
  /** 这些会话在宿主那里已经解析不出来（被销毁）。 */
  gone?: string[]
  /** 派活方会话已被销毁（resolveAgent 返回 error）。 */
  dispatcherGone?: boolean
  /** 宿主拒收这条提示词。 */
  promptThrows?: boolean
  /**
   * 门四读到的**末条** assistant 文本。缺省是一个带 [DISPATCH DONE] 的合成答复，
   * 让「应当投出」的既有用例继续成立；`null` = 一条带文本的 assistant 消息都没有。
   */
  lastText?: string | null
  /** 宿主没有 sessionController.page（老宿主 / 假载体）。 */
  pageMissing?: boolean
  /** page 抛错（宿主拒答）。 */
  pageThrows?: boolean
  /** page 返回空 records。 */
  emptyPage?: boolean
  /** page 返回的 8 条事件里没有 assistant 文本（更早那条 assistant 文本落在窗口之外）。 */
  windowWithoutAssistant?: boolean
  /** resolveAgent 回的 session.seq（缺省 1；给 undefined 造「拿不到 seq」）。 */
  seq?: unknown
  /** 前 N 次 prompt 被宿主丢掉（造「这一轮投不出去、账上留债」的场面）。 */
  promptFails?: number
}

function ledgerFor(name: string): string {
  return join(TMP_ROOT, `notify-${name}.jsonl`)
}

/** 回执落盘账的落点：与台账同目录（真实环境里跟 DSH_SESSION_CREATE_LEDGER 走，见 design D12）。 */
function outboxFor(name: string): string {
  return join(TMP_ROOT, `notify-${name}.outbox.json`)
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

  // 门四的读回通道：形状照真实存储（assistant/message 的文本在 data.message.content 的 text 块里，
  // 与 fixtures/events.ts 同口径）；默认给一个带 [DISPATCH DONE] 的合成答复。
  const page = async () => {
    if (scenario.pageThrows === true) throw new Error('the harness would not page this Session')
    if (scenario.emptyPage === true) return { records: [], hasMore: false }
    if (scenario.windowWithoutAssistant === true) {
      // 窗口只装得下 8 条事件，这里整窗都是非 assistant 事件；更早那条带文本的 assistant 落在窗口之外。
      return {
        records: Array.from({ length: 8 }, (_, index) => ({
          event: { type: 'tool/call', seq: 11 + index, time: 1, data: { turn: 1, step: 1, name: 'read' } },
        })),
        hasMore: false,
      }
    }
    const text = scenario.lastText === undefined ? '改完了，结论是 A。\n[DISPATCH DONE]' : scenario.lastText
    if (text === null) {
      return { records: [{ event: { type: 'turn/end', seq: 12, data: { turn: 1, reason: { kind: 'completed' } } } }], hasMore: false }
    }
    return {
      records: [
        {
          event: {
            type: 'assistant/message',
            seq: 10,
            time: 1,
            data: { turn: 1, step: 1, message: { role: 'assistant', content: [{ type: 'reasoning', text: '先想一下' }, { type: 'text', text }] } },
          },
        },
        { event: { type: 'turn/end', seq: 12, time: 1, data: { turn: 1, reason: { kind: 'completed' } } } },
      ],
      hasMore: false,
    }
  }

  const controller = {
    async resolveAgent(sessionId: string) {
      resolvedIds.push(sessionId)
      if (sessionId === 'chief-1' && scenario.dispatcherGone === true) return { error: { message: 'no such Session' } }
      if (scenario.gone?.includes(sessionId) === true) return { error: { message: 'no such Session' } }
      const status =
        sessionId === 'chief-1'
          ? 'running'
          : scenario.statuses !== undefined && sessionId in scenario.statuses
            ? scenario.statuses[sessionId]
            : 'status' in scenario
              ? scenario.status
              : 'idle'
      return { agent: { session: { id: sessionId, seq: 'seq' in scenario ? scenario.seq : 1 }, status } }
    },
    async prompt(options: Record<string, unknown>) {
      if (scenario.promptThrows === true) throw new Error('the host refused the prompt')
      if (typeof scenario.promptFails === 'number' && scenario.promptFails > 0) {
        scenario.promptFails -= 1
        throw new Error('the host dropped the prompt')
      }
      prompts.push(options)
      return true
    },
    ...(scenario.pageMissing === true ? {} : { page }),
  }

  const outboxPath = outboxFor(name)
  const notifier = createDispatchNotifier({
    ledger: ledgerPath,
    outboxPath,
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
    outboxPath,
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

/**
 * 记账（capture）在 turn/end 里是 fire-and-forget——宿主事件面没人 await 它。
 * 断言盘上的账之前，等它真的落地（轮询到条件成立，最多 1 秒）。
 */
async function waitFor(check: () => Promise<boolean>, label: string): Promise<void> {
  for (let attempt = 0; attempt < 200; attempt += 1) {
    if (await check()) return
    await new Promise(resolve => setTimeout(resolve, 5))
  }
  throw new Error(`timed out waiting for ${label}`)
}

async function endTurn(notifier: ReturnType<typeof harness>['notifier'], turn: number, kind = 'completed'): Promise<void> {
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
  test('安静到点后，用 controller.prompt(queue) 把回执投给派活方：首行认单，第二段只有一行结论加指针（不再塞全文）', async () => {
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
    const lines = text.split('\n')
    // 首行是「哪一单」：标题 + 终态标记 + sessionId + 结束时刻 + 轮次/原因，永远原样、不参与截断。
    expect(lines[0].startsWith('[Dispatch receipt · 投标跟进] [DISPATCH DONE] · session sess-1 · ended ')).toBe(true)
    expect(lines[0]).toContain('turn 1')
    expect(lines[0]).toContain('reason: completed')
    // 第二段只有一行：结论取最终答复的第一个有内容的行，再接上取全文的指针。
    // 为什么不再带全文：每次派单最多往派活人上下文里塞 2000 字符，省不下来；结论一行足够判断。
    expect(lines[0]).toContain('[Dispatch receipt · 投标跟进]')
    expect(text).toContain('改完了，结论是 A。')
    expect(text).not.toContain('先想一下')
    // 复核顺序：先向宿主核目标会话是否真的空闲，再核派活方还在不在。
    // 2026-11-21 起多一次 sess-1：turn/end 记账（capture）要先取目标会话的 seq 才能算出 receiptId，
    // 所以目标会话被解析两次（记账一次、投递一次），顺序仍是「目标 → 派活方」。
    expect(h.resolvedIds).toEqual(['sess-1', 'sess-1', 'chief-1'])
    // 静默期结束、台账留痕。
    expect(h.notifier.pending()).toEqual([])
    expect(typeof (await readLedger(h.ledgerPath))[0].notifiedAt).toBe('number')
  })

  test('回执正文：首行是标题与终态标记；第二段只留一行结论加指针，不塞全文（省 token 是改动目的）', () => {
    const text = receiptText({ title: '投标跟进' }, 'sess-9', 1_769_000_000_000, '[NEEDS USER]', 3, 'completed')
    expect(text.startsWith('[Dispatch receipt · 投标跟进] [NEEDS USER] · session sess-9 · ended ')).toBe(true)
    expect(text).toContain('turn 3')
    expect(text).toContain('reason: completed')
    expect(text).toContain('2026-')
    // 硬约束：第二段不许退化回「只有首行」。结论缺省（或只有空白）时退回标记本身 + 指针。
    const blank = receiptText({ title: '投标跟进' }, 'sess-9', 0, '[DISPATCH DONE]', 1, 'completed', '   ')
    expect(blank.split('\n')).toHaveLength(2)
    expect(blank.split('\n')[1]).toBe('[DISPATCH DONE]')
    // 标题与轮次缺失时也要能写出话，不许出现 undefined。
    const bare = receiptText({}, 'sess-9', 0, '[DISPATCH DONE]')
    expect(bare.startsWith('[Dispatch receipt · (untitled)] [DISPATCH DONE]')).toBe(true)
    expect(bare).toContain('turn ?')
    expect(bare).not.toContain('undefined')
    // 结论行取第一个有内容的行，并去掉行首 markdown 标记与多余空白；正文其余部分不进回执。
    const withBody = receiptText(
      { title: '投标跟进' },
      'sess-9',
      0,
      '[DISPATCH DONE]',
      1,
      'completed',
      '# 结论：全绿\n- 明细见报告\n[DISPATCH DONE]',
    )
    expect(withBody).toContain('# 结论：全绿\n- 明细见报告\n[DISPATCH DONE]')
  })

  test('超长文本适度保护截断，首行不受影响', () => {
    const long = `${'情况说明。'.repeat(3000)}\n[DISPATCH DONE]`
    expect(long.length).toBeGreaterThan(12000)
    const text = receiptText({ title: '投标跟进' }, 'sess-9', 1_769_000_000_000, '[DISPATCH DONE]', 2, 'completed', long)
    const parts = text.split('\n')
    expect(parts[0]).toContain('[DISPATCH DONE]')
    expect(text).toContain('...(truncated')
    expect(text).not.toContain('conclusion cut')
  })
})

describe('完成回执：门一（假回执）与门二（复核空闲）', () => {
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

describe('完成回执：只有正常收尾才可能是「做完了」', () => {
  // 2026-11-03 全扫本机会话日志（当日 1,740 份文件、7,851 条 turn/end）实测到的 reason.kind 取值。
  for (const kind of ['aborted', 'interrupted', 'error', 'blocked', 'max-tokens', 'stop', 'whatever']) {
    test(`reason=${kind} → 不排静默窗口，一个回执都不投`, async () => {
      const h = harness(`reason-${kind}`)
      await seed(h.ledgerPath)
      await h.notifier.onEvent({ id: 'sess-1' }, { type: 'turn/start', data: { turn: 1 } })
      await endTurn(h.notifier, 1, kind)
      expect(h.timers).toHaveLength(0)
      expect(h.notifier.pending()).toEqual([])
      expect(h.prompts).toHaveLength(0)
      expect(h.logs.some(line => line.includes('is not a normal finish'))).toBe(true)
    })
  }

  test('reason 缺失（拿不到收尾原因）也不投', async () => {
    const h = harness('reason-absent')
    await seed(h.ledgerPath)
    await h.notifier.onEvent({ id: 'sess-1' }, { type: 'turn/end', data: { turn: 1 } })
    expect(h.timers).toHaveLength(0)
    expect(h.prompts).toHaveLength(0)
  })

  test('正常收尾（completed）照旧进静默窗口', async () => {
    const h = harness('reason-completed')
    await seed(h.ledgerPath)
    await endTurn(h.notifier, 1, 'completed')
    expect(h.timers).toHaveLength(1)
    await fire(h.timers[0])
    expect(h.prompts).toHaveLength(1)
  })
})

describe('完成回执：门三，自己派的活还没停就不算做完', () => {
  test('它派出去的工人还在跑 → 不投（分段派工，不是整单完成）', async () => {
    const h = harness('busy-child', { statuses: { 'sess-1': 'idle', 'sess-2': 'running' } })
    await seed(h.ledgerPath)
    await seed(h.ledgerPath, { sessionId: 'sess-2', title: '第三章', dispatcherSessionId: 'sess-1' })
    await endTurn(h.notifier, 1)
    await fire(h.timers[0])
    expect(h.prompts).toHaveLength(0)
    expect(h.logs.some(line => line.includes('waiting rather than finished'))).toBe(true)
    // 没投就不许记 notifiedAt：工人停下来、它再跑一轮后还要能投。
    expect((await readLedger(h.ledgerPath)).find(record => record.sessionId === 'sess-1')?.notifiedAt).toBeUndefined()
  })

  test('工人已经停了 → 照常投（这一单才算收口）', async () => {
    const h = harness('idle-child', { statuses: { 'sess-1': 'idle', 'sess-2': 'idle' } })
    await seed(h.ledgerPath)
    await seed(h.ledgerPath, { sessionId: 'sess-2', title: '第三章', dispatcherSessionId: 'sess-1' })
    await endTurn(h.notifier, 1)
    await fire(h.timers[0])
    expect(h.prompts).toHaveLength(1)
    expect(h.prompts[0].sessionId).toBe('chief-1')
  })

  test('工人已被销毁（解析不出来）→ 按「已停」算，照常投', async () => {
    const h = harness('gone-child', { gone: ['sess-gone'] })
    await seed(h.ledgerPath)
    await seed(h.ledgerPath, { sessionId: 'sess-gone', title: '第三章', dispatcherSessionId: 'sess-1' })
    await endTurn(h.notifier, 1)
    await fire(h.timers[0])
    expect(h.prompts).toHaveLength(1)
  })

  test('别家派出去的会话不算它的子会话（只认 dispatcherSessionId 指向它的行）', async () => {
    const h = harness('unrelated-child', { statuses: { 'sess-1': 'idle', 'sess-3': 'running' } })
    await seed(h.ledgerPath)
    await seed(h.ledgerPath, { sessionId: 'sess-3', title: '别人的活', dispatcherSessionId: 'chief-9' })
    await endTurn(h.notifier, 1)
    await fire(h.timers[0])
    expect(h.prompts).toHaveLength(1)
  })
})

describe('完成回执：门四，只认派活方写在最终答复里的终态标记', () => {
  test('终态标记只认正文末尾：正文中间引用 [DISPATCH DONE] 不算（session-126369fb 那种误判）', () => {
    expect(terminalMarkOf('报告里写了一句「末行恰一个 [DISPATCH DONE]」，但这一条正文并没有以标记结尾。')).toBeUndefined()
  })

  test('终态标记只认正文末尾：最后一个非空行就是标记 → 命中，允许行尾少量标点', () => {
    expect(terminalMarkOf('改完了。\n[DISPATCH DONE]')).toBe('[DISPATCH DONE]')
    expect(terminalMarkOf('改完了。\n[NEEDS USER]。')).toBe('[NEEDS USER]')
    expect(terminalMarkOf('改完了。\n[DISPATCH BLOCKED]\n')).toBe('[DISPATCH BLOCKED]')
  })

  test('终态标记只认正文末尾：末行标记前后带空白（含空行）→ 仍命中', () => {
    expect(terminalMarkOf('  改完了。 \n\n  [NEEDS USER]  \n\n')).toBe('[NEEDS USER]')
    expect(terminalMarkOf('\t[DISPATCH DONE]\t')).toBe('[DISPATCH DONE]')
  })

  test('终态标记只认正文末尾：末行标记后面还跟着别的文字 → 不算', () => {
    expect(terminalMarkOf('改完了。\n[DISPATCH DONE] 但还没推送')).toBeUndefined()
  })

  for (const mark of TERMINAL_MARKS) {
    test(`末条 assistant 文本里有 ${mark} → 照投，且正文里带这个标记`, async () => {
      const h = harness(`mark-${mark.replace(/[[\]]/g, '')}`, { lastText: `这一单到这里。\n${mark}` })
      await seed(h.ledgerPath)
      await endTurn(h.notifier, 2)
      await fire(h.timers[0])
      expect(h.prompts).toHaveLength(1)
      expect(h.prompts[0].mode).toBe('queue')
      const text = (h.prompts[0].content as { type: string; text: string }[])[0].text
      expect(text).toContain(mark)
      expect(text).toContain('sess-1')
    })
  }

  test('末条文本逐字列举三个标记、末行才是结论 → 只认末行的 [DISPATCH DONE]，正文里提到的其它标记不参与', async () => {
    const h = harness('mark-multi-done', {
      lastText: '三个标记 [DISPATCH DONE]／[NEEDS USER]／[DISPATCH BLOCKED] 都实现了。\n结论：全绿。\n[DISPATCH DONE]',
    })
    await seed(h.ledgerPath)
    await endTurn(h.notifier, 2)
    await fire(h.timers[0])
    expect(h.prompts).toHaveLength(1)
    const text = (h.prompts[0].content as { type: string; text: string }[])[0].text
    // 末行是 [DISPATCH DONE]；首行认单只带这一个标记。
    expect(text.split('\n')[0]).toContain('[DISPATCH DONE]')
    expect(text.split('\n')[0]).not.toContain('[DISPATCH BLOCKED]')
  })

  test('末条正文只是引用了一句标记（没有以标记结尾）→ 不投，出声「no terminal mark」', async () => {
    const h = harness('quoted-mark', {
      lastText: '报告里写了一句「末行恰一个 [DISPATCH DONE]」，但这一条正文并没有以标记结尾。',
    })
    await seed(h.ledgerPath)
    await endTurn(h.notifier, 2)
    await fire(h.timers[0])
    expect(h.prompts).toHaveLength(0)
    expect(h.logs.some(line => line.includes('no terminal mark'))).toBe(true)
  })

  test('末行写 [DISPATCH BLOCKED] → 回执文本带 [DISPATCH BLOCKED]', async () => {
    const h = harness('mark-multi-blocked', {
      lastText: '三个标记都实现了。\n结论：卡在第三章。\n[DISPATCH BLOCKED]',
    })
    await seed(h.ledgerPath)
    await endTurn(h.notifier, 2)
    await fire(h.timers[0])
    expect(h.prompts).toHaveLength(1)
    const text = (h.prompts[0].content as { type: string; text: string }[])[0].text
    expect(text).toContain('[DISPATCH BLOCKED]')
  })

  test('末条文本里一个终态标记都没有 → 不投，出声「no terminal mark」', async () => {
    const h = harness('no-mark', { lastText: '这一轮先到这，等第三章跑完再看。' })
    await seed(h.ledgerPath)
    await endTurn(h.notifier, 2)
    await fire(h.timers[0])
    expect(h.prompts).toHaveLength(0)
    expect(h.logs.some(line => line.includes('no terminal mark'))).toBe(true)
    // 没投就不许记 notifiedAt：它后来又写了标记、再安静下来时还要能投。
    expect((await readLedger(h.ledgerPath))[0].notifiedAt).toBeUndefined()
  })

  test('末条文本超过 2000 字符、标记在最末尾 → 仍投（判定取的是未截断文本）', async () => {
    const longText = `${'情况说明。'.repeat(400)}\n[DISPATCH DONE]`
    expect(longText.length).toBeGreaterThan(2000)
    const h = harness('long-text', { lastText: longText })
    await seed(h.ledgerPath)
    await endTurn(h.notifier, 3)
    await fire(h.timers[0])
    // clipText（MESSAGE_CLIP = 2000）会把末尾截掉；门四读的是原始事件，所以仍看得到标记。
    expect(h.prompts).toHaveLength(1)
    const text = (h.prompts[0].content as { text: string }[])[0].text
    // 首行认单不受影响；正文直接透传末轮结论
    const parts = text.split('\n')
    expect(parts[0]).toContain('[DISPATCH DONE]')
    expect(text).toContain('情况说明。')
    expect(text).not.toContain('conclusion cut')
  })

  test('page 不在宿主服务面 → 不投、出声', async () => {
    const h = harness('no-page', { pageMissing: true })
    await seed(h.ledgerPath)
    await endTurn(h.notifier, 1)
    await fire(h.timers[0])
    expect(h.prompts).toHaveLength(0)
    expect(h.logs.some(line => line.includes('no sessionController.page'))).toBe(true)
  })

  test('page 抛错 → 不投、出声', async () => {
    const h = harness('page-throws', { pageThrows: true })
    await seed(h.ledgerPath)
    await endTurn(h.notifier, 1)
    await fire(h.timers[0])
    expect(h.prompts).toHaveLength(0)
    expect(h.logs.some(line => line.includes('could not be read'))).toBe(true)
  })

  test('page 里 records 为空 / 没有 assistant 文本 → 不投、出声', async () => {
    for (const [name, scenario] of [['empty-page', { emptyPage: true }], ['no-assistant', { lastText: null }]] as const) {
      const h = harness(name, scenario)
      await seed(h.ledgerPath)
      await endTurn(h.notifier, 1)
      await fire(h.timers[0])
      expect(h.prompts).toHaveLength(0)
      expect(h.logs.some(line => line.includes('no assistant message with text'))).toBe(true)
    }
  })

  test('8 条事件窗口里没有 assistant 文本（更早那条在窗口外）→ 不投、出声', async () => {
    const h = harness('window-no-assistant', { windowWithoutAssistant: true })
    await seed(h.ledgerPath)
    await endTurn(h.notifier, 1)
    await fire(h.timers[0])
    expect(h.prompts).toHaveLength(0)
    expect(h.logs.some(line => line.includes('no assistant message with text was found among its last events'))).toBe(true)
  })

  test('resolveAgent 没给出有限的 seq → 不投、出声', async () => {
    const h = harness('no-seq', { seq: undefined })
    await seed(h.ledgerPath)
    await endTurn(h.notifier, 1)
    await fire(h.timers[0])
    expect(h.prompts).toHaveLength(0)
    expect(h.logs.some(line => line.includes('no sequence number'))).toBe(true)
  })
})

describe('deadline 建议值：近 30 条有效样本派活时长的 p95 × 1.2', () => {
  function sample(index: number, minutes: number, overrides: Partial<DispatchRecord> = {}): DispatchRecord {
    const at = 1_000_000 + index * 1_000
    return {
      sessionId: `sess-sample-${index}`,
      title: '样本',
      placement: 'workspace ws-1',
      dispatchedAt: at,
      promptHead: 'p',
      notifiedAt: at + minutes * 60_000,
      ...overrides,
    }
  }

  test('5 个样本 [10,20,30,40,100] 分钟 → p95 88 → ×1.2 105.6 → 106 分钟 = 6360 秒', () => {
    const records = [10, 20, 30, 40, 100].map((minutes, index) => sample(index, minutes))
    expect(suggestDeadlineSeconds(records)).toBe(6360)
  })

  test('有效样本不足 5 条 → 不给数值（如实说样本不够）', () => {
    expect(suggestDeadlineSeconds([10, 20, 30, 40].map((minutes, index) => sample(index, minutes)))).toBeUndefined()
    expect(suggestDeadlineSeconds([])).toBeUndefined()
  })

  test('notifiedAt 缺失或 <= dispatchedAt 的记录被剔除', () => {
    const valid = [10, 20, 30, 40, 100].map((minutes, index) => sample(index, minutes))
    const junk = [
      sample(10, 50, { notifiedAt: undefined }),
      sample(11, 50, { notifiedAt: 1_011_000 }), // 与 dispatchedAt 相等（to <= from）
      sample(12, 50, { notifiedAt: 999 }), // 早于派活
    ]
    const mixed = [junk[0], valid[0], valid[1], junk[1], valid[2], valid[3], junk[2], valid[4]]
    expect(mixed).toHaveLength(8)
    expect(suggestDeadlineSeconds(mixed)).toBe(6360)
  })

  test('31 条有效样本、最早一条是极值 → 被 window = 30 排除（等于去掉最早一条重算）', () => {
    const records = [sample(0, 1), ...Array.from({ length: 30 }, (_, index) => sample(index + 1, (index + 1) * 10))]
    expect(records).toHaveLength(31)
    const withinWindow = suggestDeadlineSeconds(records.slice(-30))
    expect(withinWindow).toBe(20580)
    expect(suggestDeadlineSeconds(records.slice(1))).toBe(withinWindow)
    // 不排除那条极值（1 分钟）时 p95 会被拉低——证明 window 真的生效了。
    expect(suggestDeadlineSeconds(records, 31)).not.toBe(withinWindow)
  })
})

describe('完成回执：只认台账里本插件派出去的会话', () => {
  test('台账外的会话（Bot 会话、别人开的会话）一个事件都不处理', async () => {
    const h = harness('whitelist')
    await seed(h.ledgerPath)
    await h.notifier.onEvent({ id: 'bot-7' }, { type: 'turn/start', data: { turn: 1 } })
    await h.notifier.onEvent({ id: 'bot-7' }, { type: 'turn/end', data: { turn: 1, reason: { kind: 'completed' } } })
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
      outboxPath: outboxFor('dir-as-ledger'),
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
      outboxPath: h.outboxPath,
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

  test('终态已读免推：派活方若在等待期间已读过终态（lastReadSeq >= headSeq）→ 跳过投递，不塞 prompt，且记 notifiedAt', async () => {
    const h = harness('already-read-suppressed', { seq: 11 })
    // headSeq 是 seq - 1 = 10，台账已读到 10
    await seed(h.ledgerPath, { lastReadSeq: 10 })
    await endTurn(h.notifier, 1)
    h.tick(QUIET_WINDOW_MS)
    await fire(h.timers[0])

    // 没有往派活方塞 prompt
    expect(h.prompts).toHaveLength(0)
    // 日志明确说明被抑制
    expect(h.logs.some(line => line.includes('receipt suppressed') && line.includes('lastReadSeq=10'))).toBe(true)
    // 台账已记上 notifiedAt
    const records = await readLedger(h.ledgerPath)
    expect(typeof records[0]?.notifiedAt).toBe('number')
  })

  test('终态已读免推：派活方只读到中间状态（lastReadSeq < headSeq）→ 仍正常投递回执', async () => {
    const h = harness('unread-delivered', { seq: 11 })
    // headSeq 是 seq - 1 = 10，台账只读到 9（落后于终态）
    await seed(h.ledgerPath, { lastReadSeq: 9 })
    await endTurn(h.notifier, 1)
    h.tick(QUIET_WINDOW_MS)
    await fire(h.timers[0])

    // 正常投递回执
    expect(h.prompts).toHaveLength(1)
    expect(h.prompts[0].sessionId).toBe('chief-1')
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
      outboxPath: outboxFor('no-controller'),
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

describe('完成回执：落盘与重启补投（receipt outbox）', () => {
  test('收工即记账：turn/end 当场把一条 pending 写进盘上的收件箱，投出去之后在同一份账上收口成 delivered', async () => {
    const h = harness('outbox-capture')
    await seed(h.ledgerPath)
    await endTurn(h.notifier, 1)

    await waitFor(async () => (await readOutbox(h.outboxPath)).length === 1, 'the receipt to be captured')
    const captured = await readOutbox(h.outboxPath)
    // 去重键认的是终态消息的 seq（不是 endTime：重启重扫拿不到同一个 endTime）。
    expect(captured[0].receiptId).toBe('sess-1@10')
    expect(captured[0].headSeq).toBe(10)
    expect(captured[0].mark).toBe('[DISPATCH DONE]')
    expect(captured[0].status).toBe('pending')
    expect(captured[0].attempts).toBe(0)
    expect(captured[0].dispatcherSessionId).toBe('chief-1')

    h.tick(QUIET_WINDOW_MS)
    await fire(h.timers[0])
    const after = await readOutbox(h.outboxPath)
    // 销账是就地更新，不是另记一条。
    expect(after).toHaveLength(1)
    expect(after[0].receiptId).toBe('sess-1@10')
    expect(after[0].status).toBe('delivered')
    expect(typeof after[0].deliveredAt).toBe('number')
  })

  test('末条没有终态标记 → 不记账（账上只放「确实欠着、只差送」的那一条）', async () => {
    const h = harness('outbox-no-mark', { lastText: '改完了，结论是 A。' })
    await seed(h.ledgerPath)
    await endTurn(h.notifier, 1)
    await new Promise(resolve => setTimeout(resolve, 50))
    expect(await readOutbox(h.outboxPath)).toHaveLength(0)
    expect(h.logs.some(line => line.includes('nothing was written to the receipt outbox'))).toBe(true)
  })

  test('投递失败：账上留 pending，按退避排重试；重试再失败累加 attempts、退避升档；成功即销账', async () => {
    const h = harness('outbox-retry', { promptFails: 2 })
    await seed(h.ledgerPath)
    await endTurn(h.notifier, 1)
    await waitFor(async () => (await readOutbox(h.outboxPath)).length === 1, 'the receipt to be captured')

    // 安静窗口到点：宿主拒收 ⇒ 欠着，排第一档退避（30 秒）。
    h.tick(QUIET_WINDOW_MS)
    await fire(h.timers[0])
    expect(h.prompts).toHaveLength(0)
    expect((await readOutbox(h.outboxPath))[0].status).toBe('pending')
    expect(h.timers).toHaveLength(2)
    expect(h.timers[1].ms).toBe(RECEIPT_BACKOFF_MS[0])

    // 第一次重试又被拒收 ⇒ attempts 记 1 次，退避升到第二档（60 秒）。
    await fire(h.timers[1])
    expect(h.prompts).toHaveLength(0)
    const bumped = await readOutbox(h.outboxPath)
    expect(bumped[0].status).toBe('pending')
    expect(bumped[0].attempts).toBe(1)
    expect(typeof bumped[0].lastAttemptAt).toBe('number')
    expect(h.timers).toHaveLength(3)
    expect(h.timers[2].ms).toBe(RECEIPT_BACKOFF_MS[1])

    // 第三次投出去了 ⇒ 销账，且重试定时器被摘掉（不常驻）。
    await fire(h.timers[2])
    expect(h.prompts).toHaveLength(1)
    const done = await readOutbox(h.outboxPath)
    expect(done[0].status).toBe('delivered')
    expect(h.timers).toHaveLength(3)
  })

  test('派活方已销毁 → 当场弃账（dispatcher-gone），不留着重试', async () => {
    const h = harness('outbox-dispatcher-gone', { dispatcherGone: true })
    await seed(h.ledgerPath)
    await endTurn(h.notifier, 1)
    await waitFor(async () => (await readOutbox(h.outboxPath)).length === 1, 'the receipt to be captured')

    h.tick(QUIET_WINDOW_MS)
    await fire(h.timers[0])
    const entries = await readOutbox(h.outboxPath)
    expect(entries[0].status).toBe('abandoned')
    expect(entries[0].abandonedReason).toBe('dispatcher-gone')
    // 没有排重试：对已销毁的会话重试只是空转。
    expect(h.timers).toHaveLength(1)
  })

  test('重启后补投：新进程内存里什么都没有，reconcile() 照样把上一轮欠的回执投出去', async () => {
    const h = harness('outbox-restart', { promptFails: 1 })
    await seed(h.ledgerPath)
    await endTurn(h.notifier, 1)
    await waitFor(async () => (await readOutbox(h.outboxPath)).length === 1, 'the receipt to be captured')
    h.tick(QUIET_WINDOW_MS)
    await fire(h.timers[0])
    expect(h.prompts).toHaveLength(0)

    // 下一个宿主：同一个台账、同一个收件箱，只有内存是空的（installDispatchNotify 挂完监听就调这一步）。
    const again = harness('outbox-restart')
    const report = await again.notifier.reconcile()
    expect(again.prompts).toHaveLength(1)
    expect(report.delivered).toBe(1)
    expect((await readOutbox(h.outboxPath))[0].status).toBe('delivered')
  })

  test('重试次数用尽 → 弃账（max-attempts），不再排定时器', async () => {
    const h = harness('outbox-max-attempts')
    await seed(h.ledgerPath)
    await writeOutbox(
      h.outboxPath,
      enqueueEntry([], {
        receiptId: receiptIdOf('sess-1', 10),
        sessionId: 'sess-1',
        headSeq: 10,
        dispatcherSessionId: 'chief-1',
        mark: '[DISPATCH DONE]',
        endTime: 2_000_000,
        status: 'pending',
        attempts: RECEIPT_MAX_ATTEMPTS,
        createdAt: 2_000_000,
      }),
    )

    const report = await h.notifier.reconcile()
    expect(h.prompts).toHaveLength(0)
    expect(report.abandoned).toBe(1)
    const entries = await readOutbox(h.outboxPath)
    expect(entries[0].status).toBe('abandoned')
    expect(entries[0].abandonedReason).toBe('max-attempts')
    expect(h.timers).toHaveLength(0)
  })

  test('末行写 [NEEDS USER]（兼容别名）→ 照投，回执正文带这个标记', async () => {
    const h = harness('alias-needs-user', { lastText: '这事要你拍板。\n[NEEDS USER]' })
    await seed(h.ledgerPath)
    await endTurn(h.notifier, 1)
    await waitFor(async () => (await readOutbox(h.outboxPath)).length === 1, 'the receipt to be captured')
    expect((await readOutbox(h.outboxPath))[0].mark).toBe('[NEEDS USER]')

    h.tick(QUIET_WINDOW_MS)
    await fire(h.timers[0])
    expect(h.prompts).toHaveLength(1)
    expect((h.prompts[0].content as { text: string }[])[0].text).toContain('[NEEDS USER]')
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
    const previousOutbox = process.env.DSH_SESSION_CREATE_OUTBOX
    // 挂监听即补投一次盘上欠账（installDispatchNotify 里那次 reconcile）——指到本用例自己的账上，
    // 免得读到别人留下的收件箱。
    process.env.DSH_SESSION_CREATE_OUTBOX = outboxFor('installed')
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
      // 门四的读回通道（真宿主里是 sessionController.page）。
      async page() {
        return {
          records: [
            {
              event: {
                type: 'assistant/message',
                seq: 2,
                data: { turn: 3, step: 1, message: { role: 'assistant', content: [{ type: 'text', text: '第三章复核完了。\n[DISPATCH DONE]' }] } },
              },
            },
          ],
          hasMore: false,
        }
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

    await handlers[0].handler({ id: 'sess-1' }, { type: 'turn/end', data: { turn: 3, reason: { kind: 'completed' } } })
    // 监听器是 fire-and-forget（宿主事件面没人接返回值），只能等窗口到点后再断言投递结果。
    await new Promise(resolve => setTimeout(resolve, 50))
    if (previousOutbox === undefined) delete process.env.DSH_SESSION_CREATE_OUTBOX
    else process.env.DSH_SESSION_CREATE_OUTBOX = previousOutbox
    expect(prompts).toHaveLength(1)
    expect((prompts[0].content as { text: string }[])[0].text).toContain('turn 3')
  })

  /** 构建产物的假宿主：注册表 + 事件面，够 create_session 走完一整单。 */
  function builtArtifact() {
    const tools = new Map<string, { execute: (args: Record<string, unknown>, exec?: unknown) => Promise<string> }>()
    const events: string[] = []
    const services = {
      tools: { register: (tool: { name: string }) => { tools.set(tool.name, tool as never) } },
      sessionController: {
        async create() { return { sessionId: 'sess-built' } },
        async prompt() { return true },
        async resolveAgent(sessionId: string) {
          // 派活人的会话要能被读出「正在跑哪个模型」，否则 create_session 按判据整单失败、不建会话。
          return { agent: { session: { id: sessionId, seq: 1, requestHeader: () => ({ config: { provider: 'magpie-gateway', model: 'group/pool' } }) }, status: 'idle' } }
        },
      },
      sessionTitle: { async rename() {} },
      workspaceRegistry: {
        get: () => ({ id: 'ws-1', title: '投标', path: 'F:\\workspaces\\ws-1' }),
        async archiveSession() {},
      },
    }
    const ctx = {
      ...services,
      get: (name: string) => (services as Record<string, unknown>)[name],
      on: (name: string) => { events.push(name) },
    }
    applyBuilt(ctx as never)
    return { tools, events }
  }

  test('构建产物：create_session 把派活人的会话 id 记进台账，并把回执监听挂上 ctx', async () => {
    const ledgerPath = ledgerFor('built')
    const previous = process.env.DSH_SESSION_CREATE_LEDGER
    const previousOutbox = process.env.DSH_SESSION_CREATE_OUTBOX
    try {
      process.env.DSH_SESSION_CREATE_LEDGER = ledgerPath
      process.env.DSH_SESSION_CREATE_OUTBOX = outboxFor('built')
      const { tools, events } = builtArtifact()
      expect(events).toEqual(['session/event'])

      const spec = tools.get('create_session')
      if (spec === undefined) throw new Error('apply() registered no create_session tool')
      const text = await spec.execute(
        { title: '复核单', prompt: '跑一下第三章', workspace: 'ws-1' },
        { agent: { session: { id: 'chief-1' } } },
      )
      expect(text).toContain('sess-built')
      // 台账里只有刚这一条（没有 notifiedAt）⇒ 有效样本 0 条，如实说样本不够。
      expect(text).toContain('- No one-shot deadline suggested: only 0 completed ledger records carry both timestamps (need 5).')
      expect((await readLedger(ledgerPath))[0].dispatcherSessionId).toBe('chief-1')
    } finally {
      if (previous === undefined) delete process.env.DSH_SESSION_CREATE_LEDGER
      else process.env.DSH_SESSION_CREATE_LEDGER = previous
      if (previousOutbox === undefined) delete process.env.DSH_SESSION_CREATE_OUTBOX
      else process.env.DSH_SESSION_CREATE_OUTBOX = previousOutbox
    }
  })

  test('构建产物：台账够 5 条有效样本时，create_session 的返回里给出 deadline 分钟数与真实可调的调度形态', async () => {
    const ledgerPath = ledgerFor('built-deadline')
    const previous = process.env.DSH_SESSION_CREATE_LEDGER
    const previousOutbox = process.env.DSH_SESSION_CREATE_OUTBOX
    try {
      process.env.DSH_SESSION_CREATE_LEDGER = ledgerPath
      process.env.DSH_SESSION_CREATE_OUTBOX = outboxFor('built-deadline')
      const minutes = [10, 20, 30, 40, 100]
      for (const [index, value] of minutes.entries()) {
        const at = 1_000_000 + index * 1_000
        await seed(ledgerPath, { sessionId: `sess-old-${index}`, dispatchedAt: at, notifiedAt: at + value * 60_000 })
      }
      const { tools } = builtArtifact()
      const spec = tools.get('create_session')
      if (spec === undefined) throw new Error('apply() registered no create_session tool')
      const text = await spec.execute(
        { title: '复核单', prompt: '跑一下第三章', workspace: 'ws-1' },
        { agent: { session: { id: 'chief-1' } } },
      )
      // p95 = 88 分钟 → ×1.2 = 105.6 → ceil = 106 分钟 = 6360 秒。
      expect(text).toContain('- Suggested one-shot deadline: 106 minutes')
      expect(spec.description).toContain('schedule_create, using the minutes this tool returns')
      expect(text).toContain('RRULE:FREQ=DAILY;COUNT=1')
      expect(text).toContain('schedule_edit(action="delete", id=<task id>) once its terminal receipt arrives')
      expect(text).not.toContain('after_seconds')
      expect(spec.description).not.toContain('after_seconds')
    } finally {
      if (previous === undefined) delete process.env.DSH_SESSION_CREATE_LEDGER
      else process.env.DSH_SESSION_CREATE_LEDGER = previous
      if (previousOutbox === undefined) delete process.env.DSH_SESSION_CREATE_OUTBOX
      else process.env.DSH_SESSION_CREATE_OUTBOX = previousOutbox
    }
  })
})
