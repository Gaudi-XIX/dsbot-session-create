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
  /** auto 档写审批策略的调用：[[agent, policy]] */
  approval: unknown[][]
  /** 钉死派出去会话模型的调用（宿主 selectModel） */
  selectModel: Record<string, unknown>[]
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
  /** true = 宿主没有 approval 服务（auto 档要用） */
  noApprovalService?: boolean
  /** session.append 抛这个错（测 auto 写策略的 fail-closed 归档路径） */
  appendThrows?: Error
  /**
   * 宿主 permissionPresets 服务的形态：'with-auto'（缺省，模拟本机四档）／
   * 'without-auto'（auto-review 没装或没启用，名单里没有 auto）／'absent'（服务根本取不到）。
   */
  autoPreset?: 'with-auto' | 'without-auto' | 'absent'
  /** 派活人会话的 request/header.config：测「与派任务的 bot 模型一致」用；缺省 = 读不到 */
  dispatcherHeader?: { provider?: string; model?: string; reasoningEffort?: string }
  /** 宿主没有 selectModel（测「钉模型这重保护没生效时如实报出」） */
  noSelectModel?: boolean
  /** selectModel 抛这个错 */
  selectModelThrows?: Error
} = {}) {
  const calls: Calls = { create: [], prompt: [], rename: [], archive: [], signals: [], list: [], command: [], approval: [], selectModel: [], order: [] }
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
        return (options.resolveAgent
          ? options.resolveAgent()
          : {
              agent: {
                session: {
                  id: 'sess-1',
                  append(type: string, data: unknown) {
                    calls.approval.push([type, data])
                    calls.order.push('approval')
                    if (options.appendThrows) throw options.appendThrows
                  },
                  ...(options.dispatcherHeader === undefined
                    ? {}
                    : { requestHeader: () => ({ config: options.dispatcherHeader }) }),
                },
              },
            }) as never
      },
      ...(options.noSelectModel
        ? {}
        : {
            async selectModel(o: Record<string, unknown>) {
              calls.selectModel.push(o)
              calls.order.push('selectModel')
              if (options.selectModelThrows) throw options.selectModelThrows
              return undefined
            },
          }),
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
    ...(options.noApprovalService ? {} : { approval: {} }),
    ...(options.autoPreset === 'absent'
      ? {}
      : {
          permissionPresets: {
            names:
              options.autoPreset === 'without-auto'
                ? ['read-only', 'workspace-write', 'danger-full-access']
                : ['read-only', 'workspace-write', 'danger-full-access', 'auto'],
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
    const { ctx, calls } = fakeCtx({ workspaces: { w: { id: 'w' } }, noOptionServices: true, resolveAgent: () => ({ error: { message: 'unavailable' } }) })
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

  test('都不给 → 缺省派单走 auto，但仍不碰 agentPresets、create 也不带 agentPreset', async () => {
    const { ctx, calls } = fakeCtx(ws)
    const result = await createSessionIn(ctx, base)
    expect(calls.list).toHaveLength(0)
    // 缺省档＝auto（2026-11-01 定）：多跑一次 /permission，再把策略压成 never。
    expect(calls.command.map(c => c[1])).toEqual(['/permission auto'])
    expect(calls.approval).toEqual([['approval/policy', { policy: 'never' }]])
    expect(calls.create[0].agentPreset).toBeUndefined()
    expect(result.preset).toBeUndefined()
    expect(result.permission).toBe('auto')
    expect(result.approvalPolicy).toBe('never')
    expect(result.permissionNote).toBeUndefined()
  })

  test('preset 走 create 的 agentPreset 字段，且先查过宿主有没有这个预设', async () => {
    const { ctx, calls } = fakeCtx(ws)
    const result = await createSessionIn(ctx, { ...base, preset: 'ptc' })
    expect(calls.create[0]).toMatchObject({ workspaceId: 'w', agentPreset: 'ptc' })
    expect(calls.order).toEqual(['list', 'create', 'selectModel', 'execute', 'approval', 'prompt'])
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
    const result = await createSessionIn(ctx, { ...base, permission: 'danger-full-access' })
    expect(calls.command).toHaveLength(1)
    expect(calls.command[0][1]).toBe('/permission danger-full-access')
    expect(calls.order).toEqual(['create', 'selectModel', 'execute', 'prompt'])
    expect(result.permission).toBe('danger-full-access')
    expect(result.permissionOverriddenFrom).toBeUndefined()
  })

  // 2026-11-01 守卫：read-only / workspace-write 的审批策略是 ask，派出去的会话没人应答就整轮卡死，
  // 而且宿主没有给已存在会话提权的入口 —— 这两档一律改写成全权限，调用方原本要的值如实带出来。
  test('read-only 与 workspace-write（含大小写与空白变体）被改写成 danger-full-access，原值带在 permissionOverriddenFrom 上', async () => {
    for (const asked of ['read-only', 'workspace-write', 'READ-ONLY', ' Workspace-Write ']) {
      const { ctx, calls } = fakeCtx(ws)
      const result = await createSessionIn(ctx, { ...base, permission: asked })
      expect(calls.command[0][1]).toBe('/permission danger-full-access')
      expect(result.permission).toBe('danger-full-access')
      expect(result.permissionOverriddenFrom).toBe(asked.trim())
    }
  })

  test('环境开关 DSBOT_ALLOW_RESTRICTIVE_PERMISSION=1 时原值照发（要派只读探针时用）', async () => {
    process.env.DSBOT_ALLOW_RESTRICTIVE_PERMISSION = '1'
    try {
      const { ctx, calls } = fakeCtx(ws)
      const result = await createSessionIn(ctx, { ...base, permission: 'read-only' })
      expect(calls.command[0][1]).toBe('/permission read-only')
      expect(result.permission).toBe('read-only')
      expect(result.permissionOverriddenFrom).toBeUndefined()
    } finally {
      delete process.env.DSBOT_ALLOW_RESTRICTIVE_PERMISSION
    }
  })

  test('两项一起给：先 list、再 create（带 preset）、再 execute、最后 prompt', async () => {
    const { ctx, calls } = fakeCtx(ws)
    const result = await createSessionIn(ctx, { ...base, preset: 'ptc', permission: 'danger-full-access' })
    expect(calls.order).toEqual(['list', 'create', 'selectModel', 'execute', 'prompt'])
    expect(result).toMatchObject({ preset: 'ptc', permission: 'danger-full-access' })
  })

  // 2026-11-01 auto 档：宿主 auto 预设的审批策略被官方写死成 ask，派出去的会话没人应答，
  // auto reviewer 的 deny 就变成「等一个永远不会来的答复」——整晚卡死。这里压成 never：
  // deny 直接终结为拒绝，不弹审批窗。依据 dsh-experimental-auto-review/lib/index.js:479-483。
  test('auto 档：/permission auto 之后把审批策略压成 never，并回报 approvalPolicy', async () => {
    const { ctx, calls } = fakeCtx(ws)
    const result = await createSessionIn(ctx, { ...base, permission: 'auto' })
    expect(calls.command[0][1]).toBe('/permission auto')
    expect(calls.approval).toEqual([['approval/policy', { policy: 'never' }]])
    expect(calls.order).toEqual(['create', 'selectModel', 'execute', 'approval', 'prompt'])
    expect(result.permission).toBe('auto')
    expect(result.approvalPolicy).toBe('never')
    expect(result.permissionOverriddenFrom).toBeUndefined()
  })

  test('非 auto 档一概不碰审批策略（不影响别的设定）', async () => {
    for (const p of ['danger-full-access', 'read-only', 'workspace-write']) {
      const { ctx, calls } = fakeCtx(ws)
      const result = await createSessionIn(ctx, { ...base, permission: p })
      expect(calls.approval).toHaveLength(0)
      expect(result.approvalPolicy).toBeUndefined()
    }
  })

  test('auto 但宿主没有审批层 → 建会话之前就报错，不建会话', async () => {
    const { ctx, calls } = fakeCtx({ ...ws, noApprovalService: true })
    const error = (await createSessionIn(ctx, { ...base, permission: 'auto' }).catch(e => e)) as SessionCreateError
    expect(error.code).toBe('host-missing')
    expect(calls.create).toHaveLength(0)
  })

  test('auto 但写审批策略失败 → 归档、抛 options-failed、提示词不投', async () => {
    const dir = await tempFolder()
    const ledger = join(dir, 'ledger.jsonl')
    const { ctx, calls } = fakeCtx({ ...ws, appendThrows: new Error('append nope') })
    const error = (await createSessionIn(ctx, { ...base, permission: 'auto' }, { ledger }).catch(e => e)) as SessionCreateError
    expect(error.code).toBe('options-failed')
    expect(error.message).toContain('append nope')
    expect(calls.archive).toHaveLength(1)
    expect(calls.prompt).toHaveLength(0)
    await rm(dir, { recursive: true, force: true })
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
    const result = await createSessionIn(ctx, { ...base, preset: 'ptc', permission: 'danger-full-access' })
    expect(result.preset).toBe('ptc')
    expect(commands.seen).toEqual(['/permission danger-full-access'])
  })

  // 缺省档的三态探测（2026-11-01 加）：用户要「派单一律 auto」，但别人机器上可能没有 auto 档、
  // 或者 auto-review 集成没启用。以下五条锁住「问到就用、问不到就降级并如实说明、显式要才失败」。
  test('缺省档：名单里没有 auto → 退回 danger-full-access 并如实说明', async () => {
    const { ctx, calls } = fakeCtx({ ...ws, autoPreset: 'without-auto' })
    const result = await createSessionIn(ctx, base)
    expect(result.permission).toBe('danger-full-access')
    expect(result.approvalPolicy).toBeUndefined()
    expect(result.permissionNote).toContain('no `auto` permission preset')
    expect(calls.approval).toHaveLength(0)
  })

  test('缺省档：名单根本取不到 → 也退回 danger-full-access，不猜', async () => {
    const { ctx, calls } = fakeCtx({ ...ws, autoPreset: 'absent' })
    const result = await createSessionIn(ctx, base)
    expect(result.permission).toBe('danger-full-access')
    expect(result.permissionNote).toContain('does not expose its permission presets')
    expect(calls.command.map(c => c[1])).toEqual(['/permission danger-full-access'])
  })

  test('缺省档：有 auto 但没有审批服务 → 不选 auto（会卡在审查弹窗），退回全权限', async () => {
    const { ctx } = fakeCtx({ ...ws, noApprovalService: true })
    const result = await createSessionIn(ctx, base)
    expect(result.permission).toBe('danger-full-access')
    expect(result.permissionNote).toContain('no approval service')
  })

  test('显式要 auto 但名单明确没有 → host-missing，且根本不建会话', async () => {
    const { ctx, calls } = fakeCtx({ ...ws, autoPreset: 'without-auto' })
    await expect(createSessionIn(ctx, { ...base, permission: 'auto' })).rejects.toMatchObject({ code: 'host-missing' })
    expect(calls.create).toHaveLength(0)
  })

  test('显式要 auto 而名单取不到 → 不预先否决，照旧下发（宿主的 /permission 才是权威）', async () => {
    const { ctx, calls } = fakeCtx({ ...ws, autoPreset: 'absent' })
    const result = await createSessionIn(ctx, { ...base, permission: 'auto' })
    expect(result.permission).toBe('auto')
    expect(calls.command.map(c => c[1])).toEqual(['/permission auto'])
  })

  test('设过的选项记进派送台账（没设的就不写字段）', async () => {
    const dir = await tempFolder()
    const ledger = join(dir, 'ledger.jsonl')
    const { ctx } = fakeCtx(ws)
    await createSessionIn(ctx, { ...base, preset: 'ptc', permission: 'read-only' }, { ledger })
    await createSessionIn(ctx, base, { ledger })
    const records = (await readFile(ledger, 'utf8')).trim().split('\n').map(line => JSON.parse(line))
    expect(records[0]).toMatchObject({ preset: 'ptc', permission: 'danger-full-access', permissionOverriddenFrom: 'read-only' })
    expect(records[1].preset).toBeUndefined()
    expect(records[1].permission).toBe('auto')
    expect(records[1].approvalPolicy).toBe('never')
    expect(records[1].permissionOverriddenFrom).toBeUndefined()
    await rm(dir, { recursive: true, force: true })
  })
})

// 派出去的会话必须显式钉死模型（2026-11-02 加，用户 m00097「不能默认，而是指定模型，或者说与派任务的 bot 模型一致」）。
// 背景：宿主 create 只转传 sessionId/cwd/agentPreset/reusable，**不转传 model**，新会话于是落到「全局默认模型」；
// 2026-11-01 该默认一度是按量付费的 deepseek-account/deepseek-flash，派出去的会话因此替用户烧了真钱。
// 判据：派出去时与派活人（bot）实际用的模型一致；读不到、或不是免费池（magpie-gateway）→ 一律回落免费池。
describe('派出去的会话必须钉死模型（不许落到全局默认）', () => {
  const base = { title: 't', prompt: 'p', workspace: 'w' }
  const ws = { workspaces: { w: { id: 'w' } } }

  test('不给派活人 → 钉到免费池，结果里写明用的模型、且无告警', async () => {
    const { ctx, calls } = fakeCtx(ws)
    const result = await createSessionIn(ctx, base)
    expect(calls.selectModel).toEqual([
      { sessionId: 'sess-1', provider: 'magpie-gateway', model: 'group/pool', reasoningEffort: 'high' },
    ])
    expect(result.model).toBe('magpie-gateway/group/pool')
    expect(result.modelNote).toBeUndefined()
  })

  test('给了派活人且它用免费池 → 与派活人一致', async () => {
    const { ctx, calls } = fakeCtx({ ...ws, dispatcherHeader: { provider: 'magpie-gateway', model: 'group/high-quality' } })
    const result = await createSessionIn(ctx, base, { dispatcherSessionId: 'session-bot-1' })
    expect(calls.selectModel[0]).toEqual({ sessionId: 'sess-1', provider: 'magpie-gateway', model: 'group/high-quality' })
    expect(result.model).toBe('magpie-gateway/group/high-quality')
  })

  test('派活人用的是按量付费 provider → 一律回落免费池，绝不透传', async () => {
    const { ctx, calls } = fakeCtx({ ...ws, dispatcherHeader: { provider: 'deepseek-account', model: 'deepseek-flash' } })
    const result = await createSessionIn(ctx, base, { dispatcherSessionId: 'session-bot-1' })
    expect(calls.selectModel[0]).toEqual({
      sessionId: 'sess-1',
      provider: 'magpie-gateway',
      model: 'group/pool',
      reasoningEffort: 'high',
    })
    expect(result.model).toBe('magpie-gateway/group/pool')
  })

  test('钉模型必须发生在投提示词之前', async () => {
    const { ctx, calls } = fakeCtx(ws)
    await createSessionIn(ctx, base)
    expect(calls.order.indexOf('selectModel')).toBeLessThan(calls.order.indexOf('prompt'))
  })

  test('宿主没有 selectModel → 会话照建，但如实报出这一重保护没生效', async () => {
    const { ctx } = fakeCtx({ ...ws, noSelectModel: true })
    const result = await createSessionIn(ctx, base)
    expect(result.sessionId).toBe('sess-1')
    expect(result.modelNote).toContain('NOT pinned')
  })

  test('selectModel 抛错 → 会话照建，但如实报出原因', async () => {
    const { ctx } = fakeCtx({ ...ws, selectModelThrows: new Error('model unavailable') })
    const result = await createSessionIn(ctx, base)
    expect(result.sessionId).toBe('sess-1')
    expect(result.modelNote).toContain('model unavailable')
  })
})
