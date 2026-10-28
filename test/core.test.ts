// 用假 ctx 跑，不需要宿主：验的是 fail-closed 口径与调用序（文档 §1.2 / §三）。
import { describe, expect, test } from 'bun:test'
import { mkdir, mkdtemp, readFile, rm } from 'node:fs/promises'
import { join } from 'node:path'
import { SessionCreateError, createSessionIn, defaultLedgerPath, preflight, resolveServices, type HostCtx, type WorkspaceEntry } from '../src/core'

type Calls = {
  create: Record<string, unknown>[]
  prompt: Record<string, unknown>[]
  rename: unknown[][]
  archive: unknown[][]
  signals: (AbortSignal | undefined)[]
  list: unknown[]
  command: unknown[][]
  /** 三个会互相影响顺序的调用按实际发生次序记下来（preset 必须在第一轮之前设好）。 */
  order: string[]
}

function fakeCtx(options: {
  createResult?: { sessionId?: string }
  promptThrows?: Error
  /** true = prompt 挂到 signal 上直到被 abort（用于测超时路径） */
  promptWaitsForAbort?: boolean
  archiveThrows?: Error
  renameThrows?: Error
  resolveAgent?: () => unknown
  workspaces?: Record<string, WorkspaceEntry>
  paths?: Record<string, WorkspaceEntry>
  /** true = 服务只挂在 ctx.get 上，不直接挂在 ctx 属性上（模拟真实宿主的宽容路径） */
  viaGetOnly?: boolean
  /** 宿主 agentPresets.list() 的回包；缺省给宿主那四个 */
  presets?: { id?: string; broken?: unknown }[]
  /** commands.execute 的返回；缺省是 success */
  commandResult?: unknown
  /** true = 宿主没有 agentPresets / commands 这两个服务 */
  noOptionServices?: boolean
} = {}) {
  const calls: Calls = { create: [], prompt: [], rename: [], archive: [], signals: [], list: [], command: [], order: [] }
  let notifyPromptStarted: (() => void) | undefined
  const promptStarted = new Promise<void>(resolve => { notifyPromptStarted = resolve })
  const services = {
    tools: { register: () => undefined },
    sessionController: {
      async create(o: Record<string, unknown>) {
        calls.create.push(o)
        calls.order.push('create')
        return options.createResult ?? { sessionId: 'sess-1' }
      },
      async prompt(o: Record<string, unknown>, signal?: AbortSignal) {
        calls.prompt.push(o)
        calls.order.push('prompt')
        calls.signals.push(signal)
        notifyPromptStarted?.()
        if (options.promptThrows) throw options.promptThrows
        if (options.promptWaitsForAbort) {
          await new Promise((_resolve, reject) => {
            if (signal?.aborted) return reject(new Error('aborted'))
            signal?.addEventListener('abort', () => reject(new Error('aborted')))
          })
        }
        return true
      },
      async resolveAgent() {
        return (options.resolveAgent ? options.resolveAgent() : { agent: { session: { id: 'sess-1' } } }) as never
      },
    },
    sessionTitle: {
      async rename(session: unknown, title: string) {
        if (options.renameThrows) throw options.renameThrows
        calls.rename.push([session, title])
      },
    },
    workspaceRegistry: {
      get: (id: string) => options.workspaces?.[id],
      resolveByPath: (path: string) => options.paths?.[path],
      async archiveSession(id: string, o: unknown) {
        calls.archive.push([id, o])
        if (options.archiveThrows) throw options.archiveThrows
      },
    },
    ...(options.noOptionServices
      ? {}
      : {
          agentPresets: {
            async list() {
              calls.list.push(undefined)
              calls.order.push('list')
              return options.presets ?? [{ id: 'standard' }, { id: 'minimal' }, { id: 'ptc' }, { id: 'creator' }]
            },
          },
          commands: {
            async execute(agent: unknown, line: string, attachments: unknown[], signal: AbortSignal) {
              calls.command.push([agent, line, attachments, signal])
              calls.order.push('execute')
              return options.commandResult ?? { commandId: 'cmd-1', result: { kind: 'success' } }
            },
          },
        }),
  }
  const ctx = (options.viaGetOnly
    ? { get: (name: string) => (services as Record<string, unknown>)[name] }
    : { ...services, get: (name: string) => (services as Record<string, unknown>)[name] }) as HostCtx
  return { ctx, calls, promptStarted }
}

// 本机沙箱只允许在插件目录下写（%TEMP% 与 F:\DSBOT\tmp 都是 EPERM），临时目录放插件内。
const TMP_ROOT = join(import.meta.dir, '..', '.tmp')
const TEST_LEDGER = join(TMP_ROOT, 'core-test-ledger.jsonl')

// 台账隔离（2026-10-26 补）：本文件多数用例不显式传 `ledger`，`defaultLedgerPath()` 会回落到
// `$DSH_HOME/session-create/dispatched-sessions.jsonl` —— 那是用户真实数据目录。此前缺这行，
// 实测把 49 条测试假记录（sessionId `sess-1`）写进了真台账。放在模块顶层而不是 beforeAll：
// hook 顺序不再影响隔离；下面 `台账隔离` 那条用例把这条隔离本身锁住。
process.env.DSH_SESSION_CREATE_LEDGER = TEST_LEDGER

async function tempFolder(): Promise<string> {
  await mkdir(TMP_ROOT, { recursive: true })
  return await mkdtemp(join(TMP_ROOT, 'dsc-'))
}

describe('台账隔离', () => {
  test('默认落点必须被指到 .tmp，不得碰用户真实 $DSH_HOME', () => {
    // 若将来有人删掉文件顶部那行 env，或 defaultLedgerPath 改成不再读 env，这条会红。
    expect(defaultLedgerPath()).toBe(TEST_LEDGER)
    expect(defaultLedgerPath()).not.toContain('AgentData')
  })
})

describe('preflight', () => {
  test('全齐时报空', () => {
    const { ctx } = fakeCtx()
    expect(preflight(ctx)).toEqual([])
  })

  test('缺哪个报哪个', () => {
    const missing = preflight({ tools: {} } as HostCtx)
    expect(missing).toContain('sessionController.create')
    expect(missing).toContain('sessionController.prompt')
    expect(missing).toContain('workspaceRegistry.get')
  })

  test('宿主缺能力时不建会话', async () => {
    await expect(createSessionIn({ tools: {} } as HostCtx, { title: 't', prompt: 'p', workspace: 'w' })).rejects.toMatchObject({
      code: 'host-missing',
    })
  })
})

describe('服务获取（ctx.get 宽容路径 · 不写 inject 硬声明）', () => {
  const services: Record<string, unknown> = {
    tools: { register: () => undefined },
    sessionController: { create: () => undefined, prompt: () => undefined, resolveAgent: () => undefined },
    sessionTitle: { rename: () => undefined },
    workspaceRegistry: { get: () => undefined, archiveSession: () => undefined },
  }

  test('服务只挂在 ctx.get 上也全齐（真实宿主形态）', async () => {
    const { ctx, calls } = fakeCtx({ viaGetOnly: true, workspaces: { w: { id: 'w' } } })
    const host = resolveServices(ctx)
    expect(preflight(host)).toEqual([])
    const result = await createSessionIn(host, { title: 't', prompt: 'p', workspace: 'w' })
    expect(calls.create).toEqual([{ workspaceId: 'w' }])
    expect(result.sessionId).toBe('sess-1')
  })

  test('直接取服务抛错（未 inject 的宿主语义）→ 降级走 ctx.get，不炸', () => {
    const ctx = { get: (n: string) => services[n] } as HostCtx
    for (const key of ['tools', 'sessionController', 'sessionTitle', 'workspaceRegistry']) {
      Object.defineProperty(ctx, key, {
        get() {
          throw new Error(`cannot read ${key} without inject`)
        },
        configurable: true,
      })
    }
    expect(preflight(resolveServices(ctx))).toEqual([])
  })

  test('ctx.get 也没有 → preflight 如实报缺，且不建会话', async () => {
    const host = resolveServices({ get: () => undefined } as HostCtx)
    expect(preflight(host)).toContain('sessionController.create')
    await expect(createSessionIn(host, { title: 't', prompt: 'p', workspace: 'w' })).rejects.toMatchObject({ code: 'host-missing' })
  })
})

describe('参数校验 fail-closed', () => {
  const base = { title: 't', prompt: 'p' }

  test('folder 与 workspace 都给 → 报错', async () => {
    const { ctx, calls } = fakeCtx()
    await expect(createSessionIn(ctx, { ...base, folder: 'C:\\x', workspace: 'w' })).rejects.toMatchObject({ code: 'two-placements' })
    expect(calls.create).toHaveLength(0)
  })

  test('两个都不给 → 报错（不猜默认位置）', async () => {
    const { ctx, calls } = fakeCtx()
    await expect(createSessionIn(ctx, base)).rejects.toMatchObject({ code: 'no-placement' })
    expect(calls.create).toHaveLength(0)
  })

  test('缺 title / 缺 prompt → 报错', async () => {
    const { ctx } = fakeCtx()
    await expect(createSessionIn(ctx, { prompt: 'p', workspace: 'w' })).rejects.toMatchObject({ code: 'missing-title' })
    await expect(createSessionIn(ctx, { title: 't', workspace: 'w' })).rejects.toMatchObject({ code: 'missing-prompt' })
  })
})

describe('folder 落位', () => {
  test('存在的目录 → cwd 落位，改名 + 投递', async () => {
    const dir = await tempFolder()
    try {
      const { ctx, calls } = fakeCtx()
      const result = await createSessionIn(ctx, { title: '工作线', prompt: '干活', folder: dir })
      expect(calls.create).toEqual([{ cwd: dir }])
      expect(calls.rename).toHaveLength(1)
      expect(calls.rename[0][1]).toBe('工作线')
      expect(calls.prompt).toHaveLength(1)
      expect(calls.prompt[0]).toMatchObject({ sessionId: 'sess-1', mode: 'queue' })
      expect(calls.prompt[0].content).toEqual([{ type: 'text', text: '干活' }])
      expect(result).toMatchObject({ sessionId: 'sess-1', title: '工作线', renamed: true })
    } finally {
      await rm(dir, { recursive: true, force: true })
    }
  })

  test('目录不存在 → 报错，且一个会话都不建', async () => {
    const { ctx, calls } = fakeCtx()
    await expect(createSessionIn(ctx, { title: 't', prompt: 'p', folder: 'C:\\definitely-not-here-9f3a' })).rejects.toMatchObject({
      code: 'folder-missing',
    })
    expect(calls.create).toHaveLength(0)
    expect(calls.prompt).toHaveLength(0)
  })
})

describe('workspace 落位', () => {
  test('按 id 命中 → workspaceId 落位', async () => {
    const { ctx, calls } = fakeCtx({ workspaces: { 'ws-1': { id: 'ws-1', title: '投标' } } })
    const result = await createSessionIn(ctx, { title: 't', prompt: 'p', workspace: 'ws-1' })
    expect(calls.create).toEqual([{ workspaceId: 'ws-1' }])
    expect(result.placement).toContain('投标')
  })

  test('按路径命中（id 未命中时回退 resolveByPath）', async () => {
    const { ctx, calls } = fakeCtx({ paths: { 'F:\\proj': { id: 'ws-9', title: 'proj' } } })
    await createSessionIn(ctx, { title: 't', prompt: 'p', workspace: 'F:\\proj' })
    expect(calls.create).toEqual([{ workspaceId: 'ws-9' }])
  })

  test('workspace 认不出 → 报错，不回落默认工作区', async () => {
    const { ctx, calls } = fakeCtx()
    await expect(createSessionIn(ctx, { title: 't', prompt: 'p', workspace: 'nope' })).rejects.toMatchObject({ code: 'workspace-unknown' })
    expect(calls.create).toHaveLength(0)
  })

  test('命中工作区但没给 id → 报错，不拿路径当 workspaceId', async () => {
    const { ctx, calls } = fakeCtx({ paths: { 'F:\\proj': { title: 'proj' } } })
    await expect(createSessionIn(ctx, { title: 't', prompt: 'p', workspace: 'F:\\proj' })).rejects.toMatchObject({ code: 'workspace-unknown' })
    expect(calls.create).toHaveLength(0)
  })

  test('宿主不返回 sessionId → 报错', async () => {
    const { ctx, calls } = fakeCtx({ workspaces: { w: { id: 'w' } }, createResult: {} })
    await expect(createSessionIn(ctx, { title: 't', prompt: 'p', workspace: 'w' })).rejects.toMatchObject({ code: 'no-session-id' })
    expect(calls.prompt).toHaveLength(0)
  })
})

describe('失败处置', () => {
  test('投递失败 → 归档孤儿会话并报错，不假装成功', async () => {
    const { ctx, calls } = fakeCtx({ workspaces: { w: { id: 'w' } }, promptThrows: new Error('boom') })
    const error = (await createSessionIn(ctx, { title: 't', prompt: 'p', workspace: 'w' }).catch(e => e)) as SessionCreateError
    expect(error.code).toBe('prompt-failed')
    expect(error.message).toContain('the Session sess-1 was archived')
    expect(calls.archive).toHaveLength(1)
    expect(calls.archive[0][0]).toBe('sess-1')
    expect(calls.archive[0][1]).toEqual({ stopActivity: true })
  })

  test('归档失败 → 如实说「可能还在列表里」，不谎称已归档', async () => {
    const { ctx, calls } = fakeCtx({
      workspaces: { w: { id: 'w' } },
      promptThrows: new Error('boom'),
      archiveThrows: new Error('locked by another dsh'),
    })
    const error = (await createSessionIn(ctx, { title: 't', prompt: 'p', workspace: 'w' }).catch(e => e)) as SessionCreateError
    expect(error.code).toBe('prompt-failed')
    expect(error.message).toContain('the Session sess-1 may still be in the session list')
    expect(error.message).toContain('locked by another dsh')
    expect(error.message).not.toContain('sess-1 was archived')
    expect(calls.archive).toHaveLength(1)
  })

  test('投递中止：取消信号触发即按投递失败处理，并如实归档', async () => {
    const ac = new AbortController()
    const { ctx, calls, promptStarted } = fakeCtx({ workspaces: { w: { id: 'w' } }, promptWaitsForAbort: true })
    const pending = createSessionIn(ctx, { title: 't', prompt: 'p', workspace: 'w' }, { signal: ac.signal })
    await promptStarted
    ac.abort()
    const error = (await pending.catch(e => e)) as SessionCreateError
    expect(error.code).toBe('prompt-failed')
    expect(calls.signals[0]).toBe(ac.signal)
    expect(calls.archive).toHaveLength(1)
  })

  test('不给 signal 时自带超时信号（默认档位，不当场触发）', async () => {
    const { ctx, calls } = fakeCtx({ workspaces: { w: { id: 'w' } } })
    await createSessionIn(ctx, { title: 't', prompt: 'p', workspace: 'w' })
    expect(calls.signals[0]).toBeInstanceOf(AbortSignal)
  })

  test('改名失败不致命：如实标 renamed:false，提示词照投', async () => {
    const { ctx, calls } = fakeCtx({ workspaces: { w: { id: 'w' } }, resolveAgent: () => ({ error: { message: 'unavailable' } }) })
    const result = await createSessionIn(ctx, { title: 't', prompt: 'p', workspace: 'w' })
    expect(result.renamed).toBe(false)
    expect(calls.rename).toHaveLength(0)
    expect(calls.prompt).toHaveLength(1)
  })

  test('改名抛异常（不是返回 error）同样不致命：renamed:false，提示词照投', async () => {
    const { ctx, calls } = fakeCtx({ workspaces: { w: { id: 'w' } }, renameThrows: new Error('rename blew up') })
    const result = await createSessionIn(ctx, { title: 't', prompt: 'p', workspace: 'w' })
    expect(result.renamed).toBe(false)
    expect(calls.rename).toHaveLength(0)
    expect(calls.prompt).toHaveLength(1)
  })

  test('错误都带 SessionCreateError 类型，便于工具层分辨', async () => {
    const { ctx } = fakeCtx()
    await expect(createSessionIn(ctx, { title: 't', prompt: 'p' })).rejects.toBeInstanceOf(SessionCreateError)
  })
})


// 2026-10-27 加：派活时能选 agent 预设与权限模式（用户要求）。
// 判据：preset 在建会话时一次定死（走 create 的 agentPreset，不走 agentPresets.select ——
// 那个方法对已开跑的会话硬锁 agent-preset/locked）；permission 用宿主自己的 /permission 命令，
// 且必须在投提示词之前设好；设不成整单失败并归档，不许在错模式下干活。
describe('会话选项：agent preset 与权限模式', () => {
  const base = { title: 't', prompt: 'p', workspace: 'w' }
  const ws = { workspaces: { w: { id: 'w' } } }

  test('都不给 → 不碰这两个服务，create 也不带 agentPreset（老行为不变）', async () => {
    const { ctx, calls } = fakeCtx(ws)
    const result = await createSessionIn(ctx, base)
    expect(calls.list).toHaveLength(0)
    expect(calls.command).toHaveLength(0)
    expect(calls.create[0].agentPreset).toBeUndefined()
    expect(result.preset).toBeUndefined()
  })

  test('preset 走 create 的 agentPreset 字段，且先查过宿主有没有这个预设', async () => {
    const { ctx, calls } = fakeCtx(ws)
    const result = await createSessionIn(ctx, { ...base, preset: 'ptc' })
    expect(calls.create[0]).toMatchObject({ workspaceId: 'w', agentPreset: 'ptc' })
    expect(calls.order).toEqual(['list', 'create', 'prompt'])
    expect(result.preset).toBe('ptc')
  })

  test('预设名不存在 → preset-unknown 并列出可用值，且根本不建会话', async () => {
    const { ctx, calls } = fakeCtx(ws)
    const error = (await createSessionIn(ctx, { ...base, preset: 'nope' }).catch(e => e)) as SessionCreateError
    expect(error.code).toBe('preset-unknown')
    expect(error.message).toContain('ptc')
    expect(calls.create).toHaveLength(0)
  })

  test('预设存在但坏了（broken）→ preset-broken，不建会话（坏预设造出的会话工具跑不起来，比直接失败更难查）', async () => {
    const { ctx, calls } = fakeCtx({ ...ws, presets: [{ id: 'standard' }, { id: 'ptc', broken: 'plugin failed to load' }] })
    const error = (await createSessionIn(ctx, { ...base, preset: 'ptc' }).catch(e => e)) as SessionCreateError
    expect(error.code).toBe('preset-broken')
    expect(error.message).toContain('plugin failed to load')
    expect(calls.create).toHaveLength(0)
  })

  test('宿主没有 agentPresets.list → host-missing，不建会话', async () => {
    const { ctx, calls } = fakeCtx({ ...ws, noOptionServices: true })
    const error = (await createSessionIn(ctx, { ...base, preset: 'ptc' }).catch(e => e)) as SessionCreateError
    expect(error.code).toBe('host-missing')
    expect(calls.create).toHaveLength(0)
  })

  test('permission 走 /permission 命令，在建会话之后、投提示词之前', async () => {
    const { ctx, calls } = fakeCtx(ws)
    const result = await createSessionIn(ctx, { ...base, permission: 'read-only' })
    expect(calls.command).toHaveLength(1)
    expect(calls.command[0][1]).toBe('/permission read-only')
    expect(calls.order).toEqual(['create', 'execute', 'prompt'])
    expect(result.permission).toBe('read-only')
  })

  test('两项一起给：先 list、再 create（带 preset）、再 execute、最后 prompt', async () => {
    const { ctx, calls } = fakeCtx(ws)
    const result = await createSessionIn(ctx, { ...base, preset: 'ptc', permission: 'read-only' })
    expect(calls.order).toEqual(['list', 'create', 'execute', 'prompt'])
    expect(result).toMatchObject({ preset: 'ptc', permission: 'read-only' })
  })

  test('命令返回 error → 归档、抛 options-failed 带宿主原文、提示词不投、台账留痕', async () => {
    const dir = await tempFolder()
    const ledger = join(dir, 'ledger.jsonl')
    const { ctx, calls } = fakeCtx({
      ...ws,
      commandResult: { commandId: 'cmd-1', result: { kind: 'error', text: 'unknown preset "gone"' } },
    })
    const error = (await createSessionIn(ctx, { ...base, permission: 'gone' }, { ledger }).catch(e => e)) as SessionCreateError
    expect(error.code).toBe('options-failed')
    expect(error.message).toContain('unknown preset "gone"')
    expect(calls.archive).toHaveLength(1)
    expect(calls.prompt).toHaveLength(0)
    const records = (await readFile(ledger, 'utf8')).trim().split('\n').map(line => JSON.parse(line))
    expect(records[0].sessionId).toBe('sess-1')
    expect(records[0].failed).toContain('unknown preset')
    await rm(dir, { recursive: true, force: true })
  })

  test('命令返回形状认不出 → 也按失败处理（不许把「没看出拒绝」当成设上了）', async () => {
    const { ctx, calls } = fakeCtx({ ...ws, commandResult: { commandId: 'cmd-1', value: 'whatever' } })
    const error = (await createSessionIn(ctx, { ...base, permission: 'read-only' }).catch(e => e)) as SessionCreateError
    expect(error.code).toBe('options-failed')
    expect(error.message).toContain('unrecognized command result')
    expect(calls.prompt).toHaveLength(0)
  })

  test('归档失败时错误消息带上 sessionId（否则那个空会话谁都找不到）', async () => {
    const dir = await tempFolder()
    const ledger = join(dir, 'ledger.jsonl')
    const { ctx } = fakeCtx({
      ...ws,
      archiveThrows: new Error('archive nope'),
      commandResult: { result: { kind: 'error', text: 'denied' } },
    })
    const error = (await createSessionIn(ctx, { ...base, permission: 'read-only' }, { ledger }).catch(e => e)) as SessionCreateError
    expect(error.message).toContain('sess-1')
    expect(error.message).toContain('archive nope')
    await rm(dir, { recursive: true, force: true })
  })

  test('宿主没有 commands.execute → permission 也在建会话之前就报错，不建会话', async () => {
    const { ctx, calls } = fakeCtx({ ...ws, noOptionServices: true })
    const error = (await createSessionIn(ctx, { ...base, permission: 'read-only' }).catch(e => e)) as SessionCreateError
    expect(error.code).toBe('host-missing')
    expect(calls.create).toHaveLength(0)
  })

  test('list / execute 必须以服务本身为 receiver 调用（解构出方法再调会丢 this，真宿主里必炸）', async () => {
    const presets = {
      rows: [{ id: 'ptc' }],
      async list(this: { rows: { id: string }[] }) {
        return this.rows
      },
    }
    const commands = {
      seen: [] as string[],
      async execute(this: { seen: string[] }, _agent: unknown, line: string) {
        this.seen.push(line)
        return { result: { kind: 'success' } }
      },
    }
    const ctx = { ...fakeCtx(ws).ctx, agentPresets: presets, commands } as HostCtx
    const result = await createSessionIn(ctx, { ...base, preset: 'ptc', permission: 'read-only' })
    expect(result.preset).toBe('ptc')
    expect(commands.seen).toEqual(['/permission read-only'])
  })

  test('设过的选项记进派送台账（没设的就不写字段）', async () => {
    const dir = await tempFolder()
    const ledger = join(dir, 'ledger.jsonl')
    const { ctx } = fakeCtx(ws)
    await createSessionIn(ctx, { ...base, preset: 'ptc', permission: 'read-only' }, { ledger })
    await createSessionIn(ctx, base, { ledger })
    const records = (await readFile(ledger, 'utf8')).trim().split('\n').map(line => JSON.parse(line))
    expect(records[0]).toMatchObject({ preset: 'ptc', permission: 'read-only' })
    expect(records[1].preset).toBeUndefined()
    await rm(dir, { recursive: true, force: true })
  })
})
