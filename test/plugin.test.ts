// 冒烟测试：加载**构建产物** index.js（不是源码），用假 ctx 验证注册形状与端到端行为。
// 跑之前先 `bun run build`。宿主 SDK 由 tsconfig paths 指到 test/stubs/dsh-tools.ts。
// 台账落点被指到 .tmp 下：本测试**不许**碰用户真实的 $DSH_HOME/session-create（见 beforeAll）。
import { afterAll, beforeAll, describe, expect, test } from 'bun:test'
import { mkdir, mkdtemp, rm } from 'node:fs/promises'
import { join } from 'node:path'
import { apply, inject, name } from '../index.js'
import { realShapedEvents } from './fixtures/events'

type Spec = {
  name: string
  description: string
  parameters: Record<string, { type: string; required?: boolean; description?: string }>
  execute: (args: Record<string, unknown>, exec?: unknown) => Promise<string>
}

const TMP_ROOT = join(import.meta.dir, '..', '.tmp')
const AMBIENT_LEDGER = join(TMP_ROOT, 'plugin-test-ledger.jsonl')
const previousLedger = process.env.DSH_SESSION_CREATE_LEDGER
// 启动自检（src/autoresume.ts）默认会在 apply() 后延迟 6 秒读真盘并投递。冒烟测试不许碰真会话，
// 整段跑在关闭开关下：apply() 连定时器都不会注册。
const previousAutoResume = process.env.DSH_AUTORESUME_DISABLE

type Calls = { create: Record<string, unknown>[]; prompt: Record<string, unknown>[]; rename: unknown[][]; archive: unknown[][]; page: Record<string, unknown>[] }

function load(options: { viaGetOnly?: boolean; events?: unknown[]; noPage?: boolean; agentStatus?: string } = {}): { spec: Spec; tools: Map<string, Spec>; calls: Calls } {
  const tools = new Map<string, Spec>()
  const calls: Calls = { create: [], prompt: [], rename: [], archive: [], page: [] }
  const controller: Record<string, unknown> = {
    async create(o: Record<string, unknown>) { calls.create.push(o); return { sessionId: 'sess-9' } },
    async prompt(o: Record<string, unknown>) { calls.prompt.push(o); return true },
    async resolveAgent(sessionId: string) {
      return { agent: { session: { id: sessionId, seq: 42 }, ...(options.agentStatus === undefined ? {} : { status: options.agentStatus }) } }
    },
  }
  if (options.noPage !== true) {
    controller.page = async (o: Record<string, unknown>) => {
      calls.page.push(o)
      return { records: (options.events ?? realShapedEvents()).map(event => ({ event })), hasMore: false }
    }
  }
  const services = {
    tools: { register: (tool: Spec) => { tools.set(tool.name, tool) } },
    sessionController: controller,
    sessionTitle: { async rename(session: unknown, title: string) { calls.rename.push([session, title]) } },
    workspaceRegistry: {
      get: (id: string) => (id === 'ws-1' ? { id: 'ws-1', title: '投标' } : undefined),
      resolveByPath: () => undefined,
      async archiveSession(id: string, o: unknown) { calls.archive.push([id, o]) },
    },
  }
  // viaGetOnly：服务只挂 ctx.get，不挂 ctx 属性——真实第三方插件的形态（只 inject tools）。
  // `on` 是宿主事件面（完成回执挂在这上面），假 ctx 也得给：缺了只会打一句「挂不上回执」的警告。
  const on = (_name: string, _handler: (session: unknown, event: unknown) => void) => undefined
  const ctx = options.viaGetOnly
    ? { get: (n: string) => (services as Record<string, unknown>)[n], on }
    : { ...services, get: (n: string) => (services as Record<string, unknown>)[n], on }
  apply(ctx as never)
  const spec = tools.get('create_session')
  if (spec === undefined) throw new Error('apply() registered no create_session tool')
  return { spec, tools, calls }
}

beforeAll(async () => {
  await mkdir(TMP_ROOT, { recursive: true })
  await rm(AMBIENT_LEDGER, { force: true })
  process.env.DSH_SESSION_CREATE_LEDGER = AMBIENT_LEDGER
  process.env.DSH_AUTORESUME_DISABLE = '1'
})

afterAll(async () => {
  if (previousLedger === undefined) delete process.env.DSH_SESSION_CREATE_LEDGER
  else process.env.DSH_SESSION_CREATE_LEDGER = previousLedger
  if (previousAutoResume === undefined) delete process.env.DSH_AUTORESUME_DISABLE
  else process.env.DSH_AUTORESUME_DISABLE = previousAutoResume
  await rm(AMBIENT_LEDGER, { force: true })
})

describe('插件清单', () => {
  test('只 inject tools：其余平台服务走 ctx.get 宽容路径', () => {
    expect(name).toBe('session-create')
    expect(inject).toEqual(['tools'])
  })

  test('注册四个工具：派送、读回、台账一览、给已存在会话补话', () => {
    const { tools } = load()
    expect([...tools.keys()].sort()).toEqual(['create_session', 'list_dispatched_sessions', 'read_session_transcript', 'session_message'])
  })

  test('create_session 参数齐全且必填项正确', () => {
    const { spec } = load()
    expect(spec.name).toBe('create_session')
    expect(Object.keys(spec.parameters).sort()).toEqual(['folder', 'permission', 'preset', 'prompt', 'title', 'workspace'])
    expect(spec.parameters.title.required).toBe(true)
    expect(spec.parameters.prompt.required).toBe(true)
    expect(spec.parameters.workspace.required).toBeUndefined()
    expect(spec.parameters.folder.required).toBeUndefined()
  })
})

describe('端到端（构建产物）', () => {
  test('folder 落位：建会话 → 改名 → 投递，返回带 session id 的说明', async () => {
    const dir = await mkdtemp(join(TMP_ROOT, 'dsc-'))
    try {
      const { spec, calls } = load()
      const text = await spec.execute({ title: '投标跟进', prompt: '把 XX 做完', folder: dir })
      expect(calls.create).toEqual([{ cwd: dir }])
      expect(calls.rename[0][1]).toBe('投标跟进')
      expect(calls.prompt[0]).toMatchObject({ sessionId: 'sess-9', mode: 'queue' })
      expect(text).toContain('sess-9')
      expect(text).toContain('投标跟进')
      expect(text).toContain('Recorded in the dispatch ledger')
    } finally {
      await rm(dir, { recursive: true, force: true })
    }
  })

  test('workspace 落位', async () => {
    const { spec, calls } = load()
    const text = await spec.execute({ title: 't', prompt: 'p', workspace: 'ws-1' })
    expect(calls.create).toEqual([{ workspaceId: 'ws-1' }])
    expect(text).toContain('投标')
  })

  test('服务只挂 ctx.get 时照样注册并跑通（真实第三方插件形态）', async () => {
    const { spec, calls } = load({ viaGetOnly: true })
    const text = await spec.execute({ title: 't', prompt: 'p', workspace: 'ws-1' })
    expect(calls.create).toEqual([{ workspaceId: 'ws-1' }])
    expect(calls.prompt).toHaveLength(1)
    expect(text).toContain('sess-9')
  })

  test('服务晚到：加载时 ctx.get 全给不出，工具调用时现解析仍跑通', async () => {
    const tools = new Map<string, Spec>()
    const calls: Calls = { create: [], prompt: [], rename: [], archive: [], page: [] }
    const services: Record<string, unknown> = {
      tools: { register: (tool: Spec) => { tools.set(tool.name, tool) } },
      sessionController: {
        async create(o: Record<string, unknown>) { calls.create.push(o); return { sessionId: 'sess-late' } },
        async prompt(o: Record<string, unknown>) { calls.prompt.push(o); return true },
        async resolveAgent(sessionId: string) { return { agent: { session: { id: sessionId, seq: 42 } } } },
      },
      sessionTitle: { async rename() { return undefined } },
      workspaceRegistry: {
        get: (id: string) => (id === 'ws-1' ? { id: 'ws-1', title: '投标' } : undefined),
        resolveByPath: () => undefined,
        async archiveSession(id: string, o: unknown) { calls.archive.push([id, o]) },
      },
    }
    // ready=false 模拟「加载早于服务就绪」：apply() 时 get 一律 undefined。
    let ready = false
    const ctx = {
      tools: { register: (tool: Spec) => { tools.set(tool.name, tool) } },
      get: (n: string) => (ready ? services[n] : undefined),
    }
    apply(ctx as never)
    ready = true
    const text = await (tools.get('create_session') as Spec).execute({ title: 't', prompt: 'p', workspace: 'ws-1' })
    expect(calls.create).toEqual([{ workspaceId: 'ws-1' }])
    expect(calls.prompt).toHaveLength(1)
    expect(text).toContain('sess-late')
  })

  test('对外文案只陈述已发生的事：不说「它现在正在干」', async () => {
    const { spec } = load()
    const text = await spec.execute({ title: 't', prompt: 'p', workspace: 'ws-1' })
    expect(text).toContain('The prompt is queued in the Session.')
    expect(text).not.toContain('working on it now')
    expect(spec.parameters.prompt.description ?? '').not.toContain('right away')
  })

  test('参数不成立时返回可读错误，且不建会话', async () => {
    const { spec, calls } = load()
    expect(await spec.execute({ title: 't', prompt: 'p' })).toContain('Could not start the Session')
    expect(await spec.execute({ title: 't', prompt: 'p', folder: 'x', workspace: 'y' })).toContain('Could not start the Session')
    expect(calls.create).toHaveLength(0)
  })

  test('投递失败时归档孤儿会话并如实报错', async () => {
    const tools = new Map<string, Spec>()
    const archived: unknown[][] = []
    const ctx = {
      tools: { register: (tool: Spec) => { tools.set(tool.name, tool) } },
      sessionController: {
        async create() { return { sessionId: 'orphan-1' } },
        async prompt() { throw new Error('no agent') },
        async resolveAgent() { return { agent: { session: {} } } },
      },
      sessionTitle: { async rename() { return undefined } },
      workspaceRegistry: {
        get: (id: string) => ({ id, title: 'w' }),
        resolveByPath: () => undefined,
        async archiveSession(id: string, o: unknown) { archived.push([id, o]) },
      },
    }
    apply(ctx as never)
    const spec = tools.get('create_session') as Spec
    const text = await spec.execute({ title: 't', prompt: 'p', workspace: 'w' })
    expect(text).toContain('Could not start the Session')
    expect(archived).toEqual([['orphan-1', { stopActivity: true }]])
  })
})

describe('给已存在的会话补一条消息（构建产物）', () => {
  test('正常投递：只投一条 prompt，不建会话，回执只说「已排队」不说「它看过」', async () => {
    const { tools, calls } = load()
    const text = await (tools.get('session_message') as Spec).execute({ sessionId: 'sess-live', message: '别把契约文件漏掉' })
    expect(calls.create).toHaveLength(0)
    expect(calls.prompt).toHaveLength(1)
    expect(calls.prompt[0]).toMatchObject({ sessionId: 'sess-live', mode: 'queue', content: [{ type: 'text', text: '别把契约文件漏掉' }] })
    expect(text).toContain('Queued a message into Session sess-live')
    expect(text).toContain('The host took it into the Session\'s queue')
    expect(text).toContain('Nothing yet proves the Session has read it')
  })

  test('参数齐全且必填项正确', () => {
    const { tools } = load()
    const spec = tools.get('session_message') as Spec
    expect(Object.keys(spec.parameters).sort()).toEqual(['message', 'sessionId'])
    expect(spec.parameters.sessionId.required).toBe(true)
    expect(spec.parameters.message.required).toBe(true)
  })

  test('缺 sessionId / 缺 message → 可读错误且一条都没投', async () => {
    const { tools, calls } = load()
    const spec = tools.get('session_message') as Spec
    expect(await spec.execute({ message: 'x' })).toContain('a sessionId is required')
    expect(await spec.execute({ sessionId: 'sess-1' })).toContain('a message is required')
    expect(calls.prompt).toHaveLength(0)
  })

  test('宿主认不出的会话 id → 拒绝，且一条都没投', async () => {
    const tools = new Map<string, Spec>()
    const calls: Calls = { create: [], prompt: [], rename: [], archive: [], page: [] }
    const ctx = {
      tools: { register: (tool: Spec) => { tools.set(tool.name, tool) } },
      sessionController: {
        async prompt(o: Record<string, unknown>) { calls.prompt.push(o); return true },
        async resolveAgent() { return { error: { message: 'no such session' } } },
      },
    }
    apply(ctx as never)
    const spec = tools.get('session_message') as Spec
    const text = await spec.execute({ sessionId: 'ghost', message: 'hi' })
    expect(text).toContain('Could not send into the Session')
    expect(text).toContain('no Session "ghost"')
    expect(calls.prompt).toHaveLength(0)
  })

  test('宿主投递抛错 → 如实报错', async () => {
    const tools = new Map<string, Spec>()
    const ctx = {
      tools: { register: (tool: Spec) => { tools.set(tool.name, tool) } },
      sessionController: {
        async prompt() { throw new Error('agent gone') },
        async resolveAgent(id: string) { return { agent: { session: { id, seq: 1 } } } },
      },
    }
    apply(ctx as never)
    const spec = tools.get('session_message') as Spec
    const text = await spec.execute({ sessionId: 'sess-1', message: 'hi' })
    expect(text).toContain('Could not send into the Session')
    expect(text).toContain('agent gone')
  })

  test('宿主回 false（拒收）→ 如实报错，不说投好了', async () => {
    const tools = new Map<string, Spec>()
    const ctx = {
      tools: { register: (tool: Spec) => { tools.set(tool.name, tool) } },
      sessionController: {
        async prompt() { return false },
        async resolveAgent(id: string) { return { agent: { session: { id, seq: 1 } } } },
      },
    }
    apply(ctx as never)
    const spec = tools.get('session_message') as Spec
    const text = await spec.execute({ sessionId: 'sess-1', message: 'hi' })
    expect(text).toContain('Could not send into the Session')
    expect(text).toContain('refused')
  })

  test('宿主没有 prompt 能力 → 说明缺什么，不为凑数假装成功', async () => {
    const tools = new Map<string, Spec>()
    const ctx = {
      tools: { register: (tool: Spec) => { tools.set(tool.name, tool) } },
      sessionController: { async resolveAgent() { return { agent: { session: {} } } } },
    }
    apply(ctx as never)
    const spec = tools.get('session_message') as Spec
    const text = await spec.execute({ sessionId: 'sess-1', message: 'hi' })
    expect(text).toContain('Could not send into the Session')
    expect(text).toContain('sessionController.prompt')
  })
})

describe('派送 → 读回（构建产物）', () => {
  test('派送后按 ID 读回：状态、消息、位置都拿得到', async () => {
    const dir = await mkdtemp(join(TMP_ROOT, 'dsc-read-'))
    try {
      const { tools, calls } = load()
      const dispatchText = await (tools.get('create_session') as Spec).execute({ title: '读回一单', prompt: '把结论写出来', folder: dir })
      expect(dispatchText).toContain('sess-9')

      const read = await (tools.get('read_session_transcript') as Spec).execute({ sessionId: 'sess-9' })
      expect(read).toContain('sess-9')
      expect(read).toContain('"读回一单"')
      expect(read).toContain('still working (turn 2 has not ended, read from the Session\'s own events)')
      expect(read).toContain('改完了，结论是 A。')
      expect(read).toContain(`place: folder ${dir}`)
      expect(calls.page[0]).toMatchObject({ address: { kind: 'session', sessionId: 'sess-9' }, throughSeq: 41, maxMessages: 40 })
    } finally {
      await rm(dir, { recursive: true, force: true })
    }
  })

  test('不给 ID 就读台账里最近那一单', async () => {
    const { tools } = load()
    await (tools.get('create_session') as Spec).execute({ title: '最近一单', prompt: 'p', workspace: 'ws-1' })
    const read = await (tools.get('read_session_transcript') as Spec).execute({})
    expect(read).toContain('sess-9')
    expect(read).toContain('最近一单')
  })

  test('宿主直给状态时，读回写明这个状态来自宿主', async () => {
    const { tools } = load({ agentStatus: 'running' })
    await (tools.get('create_session') as Spec).execute({ title: '宿主状态一单', prompt: 'p', workspace: 'ws-1' })
    const read = await (tools.get('read_session_transcript') as Spec).execute({ sessionId: 'sess-9' })
    expect(read).toContain('the harness reports this Session as running')
    expect(read).not.toContain('read from the Session\'s own events')
  })

  test('台账一览：列出派送过的会话与此刻状态', async () => {
    const { tools } = load()
    await (tools.get('create_session') as Spec).execute({ title: '台账一单', prompt: 'p', workspace: 'ws-1' })
    const listed = await (tools.get('list_dispatched_sessions') as Spec).execute({})
    expect(listed).toContain('Dispatched Sessions, newest first')
    expect(listed).toContain('sess-9')
    expect(listed).toContain('still working')
  })

  test('宿主没有读历史的能力 → 读回工具给出可读说明，列表工具说明缺什么', async () => {
    const { tools } = load({ noPage: true })
    await (tools.get('create_session') as Spec).execute({ title: 't', prompt: 'p', workspace: 'ws-1' })
    const read = await (tools.get('read_session_transcript') as Spec).execute({ sessionId: 'sess-9' })
    expect(read).toContain('Could not read the Session')
    expect(read).toContain('sessionController.page')
    const listed = await (tools.get('list_dispatched_sessions') as Spec).execute({})
    expect(listed).toContain('cannot read them back')
    expect(listed).toContain('sessionController.page')
  })

  test('台账为空且不给 ID → 明确说没有可读的会话，不去猜一个', async () => {
    const empty = join(TMP_ROOT, 'empty-ledger.jsonl')
    await rm(empty, { force: true })
    process.env.DSH_SESSION_CREATE_LEDGER = empty
    try {
      const { tools } = load()
      const read = await (tools.get('read_session_transcript') as Spec).execute({})
      expect(read).toContain('give a session id')
      const listed = await (tools.get('list_dispatched_sessions') as Spec).execute({})
      expect(listed).toContain('No Session has been dispatched')
    } finally {
      process.env.DSH_SESSION_CREATE_LEDGER = AMBIENT_LEDGER
    }
  })

  test('台账读不出来（路径其实是个目录）→ 如实报原因，不说「还没派送过」', async () => {
    const asDir = await mkdtemp(join(TMP_ROOT, 'ledger-dir-'))
    process.env.DSH_SESSION_CREATE_LEDGER = asDir
    try {
      const { tools } = load()
      const listed = await (tools.get('list_dispatched_sessions') as Spec).execute({})
      expect(listed).toContain('Could not read the dispatch ledger')
      expect(listed).toContain('could not be read')
      expect(listed).not.toContain('No Session has been dispatched')
      const read = await (tools.get('read_session_transcript') as Spec).execute({})
      expect(read).toContain('Could not read the Session')
      expect(read).toContain('could not be read')
      expect(read).not.toContain('give a session id')
    } finally {
      process.env.DSH_SESSION_CREATE_LEDGER = AMBIENT_LEDGER
      await rm(asDir, { recursive: true, force: true })
    }
  })
})
