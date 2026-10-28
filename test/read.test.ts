// 读回通道的单元测试：台账（记住会话 ID）+ 转写渲染（拿到结果）+ 状态判定（跑完没有）。
// 会话事件形状来自真实存储实测，见 test/fixtures/events.ts 顶部注释。
// 这里的 ctx 是假的（自造），所以「逻辑对不对」能测；「真宿主里这四件事能不能拿到」测不到，
// 那一条由 docs/chief-session-create-capability-20261026.md §十一 的「未验项」如实标着。
import { afterAll, beforeAll, describe, expect, test } from 'bun:test'
import { mkdir, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises'
import { join } from 'node:path'
import {
  MESSAGES_MAX,
  appendDispatch,
  clamp,
  createSessionIn,
  defaultLedgerPath,
  listDispatchedIn,
  markRead,
  preflightRead,
  readLedger,
  readSessionIn,
  renderTranscript,
  resolveServices,
  SessionCreateError,
  stamp,
  type HostCtx,
} from '../src/core'
import { realShapedEvents } from './fixtures/events'

const TMP_ROOT = join(import.meta.dir, '..', '.tmp')
const AMBIENT_LEDGER = join(TMP_ROOT, 'read-test-ambient.jsonl')
const previousLedger = process.env.DSH_SESSION_CREATE_LEDGER

// 本文件里个别用例不显式给台账路径，此时会用默认落点 —— 指到 .tmp，绝不碰用户真实的 $DSH_HOME。
beforeAll(async () => {
  await mkdir(TMP_ROOT, { recursive: true })
  process.env.DSH_SESSION_CREATE_LEDGER = AMBIENT_LEDGER
})

afterAll(async () => {
  if (previousLedger === undefined) delete process.env.DSH_SESSION_CREATE_LEDGER
  else process.env.DSH_SESSION_CREATE_LEDGER = previousLedger
  await rm(AMBIENT_LEDGER, { force: true })
})

type PageCall = Record<string, unknown>

function fakeCtx(options: {
  events?: unknown[]
  seq?: number
  hasMore?: boolean
  noPage?: boolean
  pageThrows?: Error
  resolveAgent?: (sessionId: string) => Promise<unknown>
  noResolveAgent?: boolean
  agentStatus?: string
} = {}): { ctx: HostCtx; calls: { page: PageCall[] } } {
  const calls = { page: [] as PageCall[] }
  const seq = options.seq ?? 42
  const controller: Record<string, unknown> = {}
  if (options.noPage !== true) {
    controller.page = async (call: PageCall) => {
      calls.page.push(call)
      if (options.pageThrows !== undefined) throw options.pageThrows
      return { records: (options.events ?? []).map(event => ({ event })), hasMore: options.hasMore === true }
    }
  }
  if (options.noResolveAgent !== true) {
    controller.resolveAgent = options.resolveAgent ?? (async () => ({
      agent: { session: { seq }, ...(options.agentStatus === undefined ? {} : { status: options.agentStatus }) },
    }))
  }
  const services: Record<string, unknown> = { tools: { register: () => undefined }, sessionController: controller }
  // 服务只挂 ctx.get —— 真实第三方插件的形态（本插件只 inject tools）。
  const ctx = { get: (name: string) => services[name] } as HostCtx
  return { ctx: resolveServices(ctx), calls }
}

async function tempDir(): Promise<string> {
  await mkdir(TMP_ROOT, { recursive: true })
  return mkdtemp(join(TMP_ROOT, 'read-'))
}

async function newLedger(dir: string, sessionIds: string[]): Promise<string> {
  const ledger = join(dir, 'dispatched-sessions.jsonl')
  for (const sessionId of sessionIds) {
    await appendDispatch(ledger, {
      sessionId,
      title: `活-${sessionId}`,
      placement: `folder F:\\x\\${sessionId}`,
      dispatchedAt: Date.parse('2026-10-26T19:30:00+08:00'),
      promptHead: '把这件事做完',
    })
  }
  return ledger
}

async function codeOf(run: () => Promise<unknown>): Promise<string> {
  try {
    await run()
    return '(no error)'
  } catch (error) {
    return error instanceof SessionCreateError ? error.code : String(error)
  }
}

// ---------------------------------------------------------------------------
// 转写渲染：谁说了什么 + 这轮跑完没有
// ---------------------------------------------------------------------------

describe('renderTranscript', () => {
  test('全部事件：最后一轮没结束 → running；turn 号与 head seq 取到', () => {
    const rendered = renderTranscript(realShapedEvents())
    expect(rendered.status).toBe('running')
    expect(rendered.turn).toBe(2)
    expect(rendered.headSeq).toBe(41)
  })

  test('只到 turn/end → idle（这就是「跑完了」的判据）', () => {
    const rendered = renderTranscript(realShapedEvents().slice(0, 13))
    expect(rendered.status).toBe('idle')
    expect(rendered.turn).toBe(1)
    expect(rendered.headSeq).toBe(35)
  })

  test('还没有 turn/start → not-started', () => {
    const rendered = renderTranscript(realShapedEvents().slice(0, 3))
    expect(rendered.status).toBe('not-started')
    expect(rendered.turn).toBeUndefined()
    expect(rendered.messages).toEqual([])
  })

  test('只取真人输入与助手文本：交接便条、工具结果、推理块都不算消息', () => {
    const rendered = renderTranscript(realShapedEvents())
    expect(rendered.messages.map(message => [message.role, message.text])).toEqual([
      ['user', '请把结论写到 docs/x.md'],
      ['assistant', '我先看一下现状。'],
      ['assistant', '改完了，结论是 A。'],
      ['assistant', '再看一处。'],
    ])
    const allText = rendered.messages.map(message => message.text).join('\n')
    expect(allText).not.toContain('交接便条')
    expect(allText).not.toContain('先想一下')
    expect(allText).not.toContain('文件内容')
  })

  test('assistant/message 里只有推理与工具调用 → 不产出空消息', () => {
    const rendered = renderTranscript([
      { type: 'turn/start', seq: 1, data: { turn: 1 } },
      {
        type: 'assistant/message',
        seq: 2,
        data: { turn: 1, step: 1, message: { role: 'assistant', content: [{ type: 'reasoning', text: '想' }, { type: 'tool-call', id: 'c', name: 'read', arguments: '{}' }] } },
      },
    ])
    expect(rendered.messages).toEqual([])
  })

  test('超长消息被裁剪并如实标出总长度', () => {
    const long = 'x'.repeat(2_500)
    const rendered = renderTranscript([
      { type: 'turn/start', seq: 1, data: { turn: 1 } },
      { type: 'assistant/message', seq: 2, data: { turn: 1, step: 1, message: { role: 'assistant', content: [{ type: 'text', text: long }] } } },
    ])
    expect(rendered.messages[0].text).toContain('(cut; 2500 characters in all)')
    expect(rendered.messages[0].text.length).toBeLessThan(long.length)
  })

  test('坏输入不炸：空、null、字符串、缺 data 一律跳过', () => {
    const rendered = renderTranscript([null, 'x', 42, { type: 'user/message' }, { type: 'turn/end', data: {} }])
    expect(rendered.headSeq).toBe(0)
    expect(rendered.messages).toEqual([])
    expect(rendered.status).toBe('not-started')
  })
})

// ---------------------------------------------------------------------------
// 台账：派送时记住会话 ID
// ---------------------------------------------------------------------------

describe('台账', () => {
  test('落点约定：显式环境变量 > DSH_HOME > ~/.dsh；DSH_HOME 下跟 DS Bot 自己的 home（bot/）走', () => {
    expect(defaultLedgerPath({ DSH_SESSION_CREATE_LEDGER: 'F:\\a\\l.jsonl', DSH_HOME: 'F:\\b' }, 'C:\\h')).toBe('F:\\a\\l.jsonl')
    expect(defaultLedgerPath({ DSH_HOME: 'F:\\b' }, 'C:\\h')).toBe(join('F:\\b', 'bot', 'session-create', 'dispatched-sessions.jsonl'))
    expect(defaultLedgerPath({}, 'C:\\h')).toBe(join('C:\\h', '.dsh', 'bot', 'session-create', 'dispatched-sessions.jsonl'))
  })

  test('追加 → 读回；同一会话只留最后一条；坏行跳过；文件不存在返回空', async () => {
    const dir = await tempDir()
    try {
      const ledger = join(dir, 'l.jsonl')
      expect(await readLedger(ledger)).toEqual([])
      await appendDispatch(ledger, { sessionId: 's1', title: '一', placement: 'p', dispatchedAt: 1, promptHead: 'a' })
      await appendDispatch(ledger, { sessionId: 's2', title: '二', placement: 'p', dispatchedAt: 2, promptHead: 'b' })
      await appendDispatch(ledger, { sessionId: 's1', title: '一改', placement: 'p', dispatchedAt: 3, promptHead: 'a2' })
      const body = await readFile(ledger, 'utf8')
      await writeFile(ledger, `${body}{ 这不是 JSON\n`, 'utf8')
      const records = await readLedger(ledger)
      // 按派送时间升序：s1 被重复派送后时间最新，排到最后（同一会话只留最后一条内容）。
      expect(records.map(record => record.sessionId)).toEqual(['s2', 's1'])
      expect(records[1].title).toBe('一改')
    } finally {
      await rm(dir, { recursive: true, force: true })
    }
  })

  test('文件不存在 = 空；文件存在却读不出来 = 如实报错，不当成空', async () => {
    const dir = await tempDir()
    try {
      expect(await readLedger(join(dir, 'nope.jsonl'))).toEqual([])
      // 路径指向一个**存在的目录**：readFile 抛的是 EISDIR，不是 ENOENT。
      const asDir = join(dir, 'ledger-as-dir')
      await mkdir(asDir, { recursive: true })
      let caught: SessionCreateError | undefined
      try {
        await readLedger(asDir)
      } catch (error) {
        caught = error as SessionCreateError
      }
      expect(caught).toBeInstanceOf(SessionCreateError)
      expect(caught?.code).toBe('ledger-unreadable')
      expect(caught?.message).toContain('could not be read')
    } finally {
      await rm(dir, { recursive: true, force: true })
    }
  })

  test('markRead 记下读到的位置；未登记的会话返回 false', async () => {
    const dir = await tempDir()
    try {
      const ledger = await newLedger(dir, ['s1', 's2'])
      expect(await markRead(ledger, 's1', 41, 1234)).toBe(true)
      expect(await markRead(ledger, 'nope', 1)).toBe(false)
      const records = await readLedger(ledger)
      expect(records.map(record => record.sessionId)).toEqual(['s1', 's2'])
      expect(records[0]).toMatchObject({ lastReadSeq: 41, lastReadAt: 1234 })
      expect(records[1].lastReadSeq).toBeUndefined()
    } finally {
      await rm(dir, { recursive: true, force: true })
    }
  })

  test('派送成功即写台账，返回里带会话 ID 与台账路径', async () => {
    const dir = await tempDir()
    try {
      const ledger = join(dir, 'l.jsonl')
      const { ctx } = fakeCtx({ seq: 0 })
      const services = { ...ctx } as HostCtx
      services.sessionController = {
        ...services.sessionController,
        async create() { return { sessionId: 'sess-77' } },
        async prompt() { return true },
        async resolveAgent() { return { agent: { session: { seq: 0 } } } },
      }
      services.sessionTitle = { async rename() { return undefined } }
      services.workspaceRegistry = { get: (id: string) => ({ id, title: 'w' }), async archiveSession() { return undefined } }
      const result = await createSessionIn(services, { title: '派送一单', prompt: '把结果写出来', workspace: 'w' }, { ledger, signal: new AbortController().signal })
      expect(result.sessionId).toBe('sess-77')
      expect(result.ledgerError).toBeUndefined()
      const records = await readLedger(ledger)
      expect(records).toHaveLength(1)
      expect(records[0]).toMatchObject({ sessionId: 'sess-77', title: '派送一单', placement: 'workspace w', promptHead: '把结果写出来' })
    } finally {
      await rm(dir, { recursive: true, force: true })
    }
  })

  test('台账写不进去也算派送成功，但如实报出、不假装记住了', async () => {
    const { ctx } = fakeCtx({ seq: 0 })
    const services = { ...ctx, tools: { register: () => undefined } } as HostCtx
    services.sessionController = {
      ...services.sessionController,
      async create() { return { sessionId: 'sess-88' } },
      async prompt() { return true },
      async resolveAgent() { return { agent: { session: { seq: 0 } } } },
    }
    services.sessionTitle = { async rename() { return undefined } }
    services.workspaceRegistry = { get: (id: string) => ({ id, title: 'w' }), async archiveSession() { return undefined } }
    const dir = await tempDir()
    try {
      // 把台账路径指到一个「父级是文件」的位置，mkdir 必失败。
      const blocker = join(dir, 'blocker')
      await writeFile(blocker, 'x', 'utf8')
      const result = await createSessionIn(services, { title: 't', prompt: 'p', workspace: 'w' }, { ledger: join(blocker, 'l.jsonl'), signal: new AbortController().signal })
      expect(result.sessionId).toBe('sess-88')
      expect(result.ledgerError).toBeTruthy()
    } finally {
      await rm(dir, { recursive: true, force: true })
    }
  })
})

// ---------------------------------------------------------------------------
// 按 ID 读回：拿到会话结束后的结果
// ---------------------------------------------------------------------------

describe('readSessionIn', () => {
  test('按 ID 读回：状态、位置、上次读数、分页参数都对', async () => {
    const dir = await tempDir()
    try {
      const ledger = await newLedger(dir, ['sess-1'])
      const { ctx, calls } = fakeCtx({ events: realShapedEvents(), seq: 42 })
      const transcript = await readSessionIn(ctx, { sessionId: 'sess-1' }, { ledger, signal: new AbortController().signal })
      expect(transcript.status).toBe('running')
      expect(transcript.headSeq).toBe(41)
      expect(transcript.turn).toBe(2)
      expect(transcript.title).toBe('活-sess-1')
      expect(transcript.placement).toBe('folder F:\\x\\sess-1')
      expect(transcript.newEvents).toBeUndefined()
      expect(transcript.messages.at(-1)?.text).toBe('再看一处。')
      expect(calls.page).toHaveLength(1)
      expect(calls.page[0]).toMatchObject({ address: { kind: 'session', sessionId: 'sess-1' }, throughSeq: 41, maxMessages: 40 })
    } finally {
      await rm(dir, { recursive: true, force: true })
    }
  })

  test('读一次就把位置记进台账；第二次读就只报新事件数', async () => {
    const dir = await tempDir()
    try {
      const ledger = await newLedger(dir, ['sess-1'])
      const first = await readSessionIn(fakeCtx({ events: realShapedEvents(), seq: 42 }).ctx, { sessionId: 'sess-1' }, { ledger, signal: new AbortController().signal })
      expect(first.ledgerError).toBeUndefined()
      expect((await readLedger(ledger))[0]).toMatchObject({ lastReadSeq: 41 })

      const second = await readSessionIn(fakeCtx({ events: realShapedEvents(), seq: 42 }).ctx, { sessionId: 'sess-1' }, { ledger, signal: new AbortController().signal })
      expect(second.newEvents).toBe(0)

      const grown = await readSessionIn(fakeCtx({ events: realShapedEvents(), seq: 47 }).ctx, { sessionId: 'sess-1' }, { ledger, signal: new AbortController().signal })
      expect(grown.newEvents).toBe(5)
      expect(grown.headSeq).toBe(46)
    } finally {
      await rm(dir, { recursive: true, force: true })
    }
  })

  test('不给 ID 就读台账里最后派送的那一单', async () => {
    const dir = await tempDir()
    try {
      const ledger = await newLedger(dir, ['sess-1', 'sess-2'])
      const { ctx, calls } = fakeCtx({ events: realShapedEvents(), seq: 42 })
      const transcript = await readSessionIn(ctx, {}, { ledger, signal: new AbortController().signal })
      expect(transcript.sessionId).toBe('sess-2')
      expect(calls.page[0]).toMatchObject({ address: { kind: 'session', sessionId: 'sess-2' } })
    } finally {
      await rm(dir, { recursive: true, force: true })
    }
  })

  test('last 被夹到 1..200', async () => {
    const dir = await tempDir()
    try {
      const ledger = await newLedger(dir, ['sess-1'])
      const big = fakeCtx({ events: realShapedEvents(), seq: 42, hasMore: true })
      const transcript = await readSessionIn(big.ctx, { sessionId: 'sess-1', last: 9_999 }, { ledger, signal: new AbortController().signal })
      expect(big.calls.page[0].maxMessages).toBe(MESSAGES_MAX)
      expect(transcript.hasMore).toBe(true)
      const small = fakeCtx({ events: realShapedEvents(), seq: 42 })
      await readSessionIn(small.ctx, { sessionId: 'sess-1', last: -5 }, { ledger, signal: new AbortController().signal })
      expect(small.calls.page[0].maxMessages).toBe(1)
    } finally {
      await rm(dir, { recursive: true, force: true })
    }
  })

  test('不给 ID 且台账为空 → 明确报错，不去猜一个会话', async () => {
    const dir = await tempDir()
    try {
      const { ctx, calls } = fakeCtx()
      expect(await codeOf(() => readSessionIn(ctx, {}, { ledger: join(dir, 'none.jsonl') }))).toBe('no-session')
      expect(calls.page).toHaveLength(0)
    } finally {
      await rm(dir, { recursive: true, force: true })
    }
  })

  test('给了 ID 但台账读不出来：照常读回会话本身，并如实带出台账原因', async () => {
    const dir = await tempDir()
    try {
      const asDir = join(dir, 'ledger-as-dir')
      await mkdir(asDir, { recursive: true })
      const { ctx } = fakeCtx({ events: realShapedEvents() })
      const transcript = await readSessionIn(ctx, { sessionId: 'sess-1' }, { ledger: asDir })
      expect(transcript.sessionId).toBe('sess-1')
      expect(transcript.messages.length).toBeGreaterThan(0)
      expect(transcript.ledgerError).toContain('could not be read')
      // 台账读不出来 → 没有前次读数可比，不编一个「新增 0 条」。
      expect(transcript.newEvents).toBeUndefined()
    } finally {
      await rm(dir, { recursive: true, force: true })
    }
  })

  test('不给 ID 且台账读不出来 → ledger-unreadable，而不是「还没派送过」', async () => {
    const dir = await tempDir()
    try {
      const asDir = join(dir, 'ledger-as-dir')
      await mkdir(asDir, { recursive: true })
      const { ctx, calls } = fakeCtx()
      expect(await codeOf(() => readSessionIn(ctx, {}, { ledger: asDir }))).toBe('ledger-unreadable')
      expect(calls.page).toHaveLength(0)
    } finally {
      await rm(dir, { recursive: true, force: true })
    }
  })

  test('宿主不认识这个 ID → session-unknown，且不读历史', async () => {
    const dir = await tempDir()
    try {
      const ledger = await newLedger(dir, ['sess-1'])
      const { ctx, calls } = fakeCtx({ resolveAgent: async () => ({ error: { message: 'unknown session' } }) })
      expect(await codeOf(() => readSessionIn(ctx, { sessionId: 'sess-1' }, { ledger }))).toBe('session-unknown')
      expect(calls.page).toHaveLength(0)
    } finally {
      await rm(dir, { recursive: true, force: true })
    }
  })

  test('拿不到事件的序号 → 拒绝读（不猜截止位置）', async () => {
    const { ctx } = fakeCtx({ resolveAgent: async () => ({ agent: { session: {} } }) })
    expect(await codeOf(() => readSessionIn(ctx, { sessionId: 'sess-1' }, { signal: new AbortController().signal }))).toBe('session-no-seq')
  })

  test('宿主没有读历史的能力 → 报出缺的是哪一个，而不是静默返回空', async () => {
    const { ctx } = fakeCtx({ noPage: true })
    expect(preflightRead(ctx)).toEqual(['sessionController.page'])
    const error = await readSessionIn(ctx, { sessionId: 'sess-1' }, { signal: new AbortController().signal }).catch((e: unknown) => e)
    expect(error).toBeInstanceOf(SessionCreateError)
    expect((error as SessionCreateError).code).toBe('host-missing')
    expect((error as SessionCreateError).message).toContain('sessionController.page')
  })

  test('宿主读历史时抛错 → read-failed，带原始原因', async () => {
    const { ctx } = fakeCtx({ pageThrows: new Error('page exploded') })
    const error = await readSessionIn(ctx, { sessionId: 'sess-1' }, { signal: new AbortController().signal }).catch((e: unknown) => e)
    expect((error as SessionCreateError).code).toBe('read-failed')
    expect((error as SessionCreateError).message).toContain('page exploded')
  })

  test('markRead:false（列表用）不改台账', async () => {
    const dir = await tempDir()
    try {
      const ledger = await newLedger(dir, ['sess-1'])
      await readSessionIn(fakeCtx({ events: realShapedEvents(), seq: 42 }).ctx, { sessionId: 'sess-1' }, { ledger, markRead: false })
      expect((await readLedger(ledger))[0].lastReadSeq).toBeUndefined()
    } finally {
      await rm(dir, { recursive: true, force: true })
    }
  })

  test('宿主直给的状态优先于事件推断：事件看着跑完了、宿主说还在跑 → 还在跑', async () => {
    const { ctx } = fakeCtx({ events: realShapedEvents().slice(0, 13), seq: 36, agentStatus: 'running' })
    const transcript = await readSessionIn(ctx, { sessionId: 'sess-1' }, { signal: new AbortController().signal })
    expect(transcript.status).toBe('running')
    expect(transcript.statusFrom).toBe('host')
  })

  test('反向同理：事件看着还在跑、宿主说已停 → 已停', async () => {
    const { ctx } = fakeCtx({ events: realShapedEvents(), seq: 42, agentStatus: 'idle' })
    const transcript = await readSessionIn(ctx, { sessionId: 'sess-1' }, { signal: new AbortController().signal })
    expect(transcript.status).toBe('idle')
    expect(transcript.statusFrom).toBe('host')
  })

  test('宿主不给状态、或给了没见过的值 → 退回事件推断，并如实标出来源', async () => {
    const noStatus = await readSessionIn(fakeCtx({ events: realShapedEvents(), seq: 42 }).ctx, { sessionId: 'sess-1' }, { signal: new AbortController().signal })
    expect(noStatus.status).toBe('running')
    expect(noStatus.statusFrom).toBe('transcript')

    const weird = await readSessionIn(fakeCtx({ events: realShapedEvents(), seq: 42, agentStatus: 'paused' }).ctx, { sessionId: 'sess-1' }, { signal: new AbortController().signal })
    expect(weird.status).toBe('running')
    expect(weird.statusFrom).toBe('transcript')
  })
})

// ---------------------------------------------------------------------------
// 台账 + 状态一览
// ---------------------------------------------------------------------------

describe('listDispatchedIn', () => {
  test('最新的排最前，每条给出现刻状态；列表不改台账', async () => {
    const dir = await tempDir()
    try {
      const ledger = await newLedger(dir, ['sess-old', 'sess-new'])
      const { ctx } = fakeCtx({ events: realShapedEvents().slice(0, 13), seq: 36 })
      const listed = await listDispatchedIn(ctx, {}, { ledger, signal: new AbortController().signal })
      expect(listed.ledgerPath).toBe(ledger)
      expect(listed.lines.map(line => line.record.sessionId)).toEqual(['sess-new', 'sess-old'])
      expect(listed.lines[0].status).toBe('idle')
      expect(listed.lines[0].headSeq).toBe(35)
      expect((await readLedger(ledger)).every(record => record.lastReadSeq === undefined)).toBe(true)
    } finally {
      await rm(dir, { recursive: true, force: true })
    }
  })

  test('某一条读不出来时只标这一条，其余照常', async () => {
    const dir = await tempDir()
    try {
      const ledger = await newLedger(dir, ['sess-bad', 'sess-ok'])
      const { ctx } = fakeCtx({
        events: realShapedEvents(),
        seq: 42,
        resolveAgent: async (sessionId: string) => (sessionId === 'sess-bad' ? { error: { message: 'gone' } } : { agent: { session: { seq: 42 } } }),
      })
      const listed = await listDispatchedIn(ctx, {}, { ledger, signal: new AbortController().signal })
      // 最新的排最前 → 坏的那条在最后
      expect(listed.lines[0].status).toBe('running')
      expect(listed.lines[0].error).toBeUndefined()
      expect(listed.lines[1].error).toBeTruthy()
      expect(listed.lines[1].status).toBeUndefined()
    } finally {
      await rm(dir, { recursive: true, force: true })
    }
  })

  test('limit 夹到 1..20，取最新若干条', async () => {
    const dir = await tempDir()
    try {
      const ledger = await newLedger(dir, ['s1', 's2', 's3'])
      const { ctx } = fakeCtx()
      const listed = await listDispatchedIn(ctx, { limit: 99 }, { ledger, signal: new AbortController().signal })
      expect(listed.lines.map(line => line.record.sessionId)).toEqual(['s3', 's2', 's1'])
      const one = await listDispatchedIn(ctx, { limit: 0 }, { ledger, signal: new AbortController().signal })
      expect(one.lines.map(line => line.record.sessionId)).toEqual(['s3'])
    } finally {
      await rm(dir, { recursive: true, force: true })
    }
  })
})

describe('clamp', () => {
  test('取整并夹在范围内；NaN 落到下界', () => {
    expect(clamp(2.4, 1, 10)).toBe(2)
    expect(clamp(-1, 1, 10)).toBe(1)
    expect(clamp(99, 1, 10)).toBe(10)
    expect(clamp(Number.NaN, 3, 10)).toBe(3)
  })
})

describe('stamp', () => {
  test('一律按东八区渲染，不跟随进程时区', () => {
    // 2026-10-26 19:30:00 +08:00 = 11:30:00Z
    expect(stamp(Date.UTC(2026, 9, 26, 11, 30, 0))).toBe('2026-10-26 19:30:00')
    // 跨日界：2026-10-26 23:30Z = 10-27 07:30 东八
    expect(stamp(Date.UTC(2026, 9, 26, 23, 30, 0))).toBe('2026-10-27 07:30:00')
    expect(stamp(0)).toBe('?')
  })
})
