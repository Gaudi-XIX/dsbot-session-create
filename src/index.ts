// 宿主半边：注册三个工具 —— create_session（派送）、read_session_transcript（按 ID 读回）、
// list_dispatched_sessions（看派送台账与各条此刻的状态）。
// inject 只声明 tools：其余平台服务走 ctx.get() 宽容路径（core.resolveServices）。
// 理由见 docs/chief-session-create-capability-20261026.md §三.8——硬 inject 会在宿主缺服务时
// 让整棵插件树加载失败，preflight 那句可读报错就永远不会被执行。
import { defineTool } from '@deepseek-ai/dsh-tools'
import {
  SessionCreateError,
  createSessionIn,
  dispatcherSessionOf,
  installDispatchNotify,
  listDispatchedIn,
  preflight,
  preflightOptions,
  preflightRead,
  readSessionIn,
  resolveServices,
  stamp,
  type CreateArgs,
  type HostCtx,
  type ReadArgs,
  type Transcript,
} from './core'

export const name = 'session-create'
export const inject = ['tools']

const output = {
  schema: { type: 'string' },
  render: (_args: unknown, value: unknown) => [{ type: 'text', text: String(value) }],
}

const CREATE_DESCRIPTION = [
  'Start a new Session in a DSH workspace or an existing working folder you name, and deliver one prompt into it.',
  'Give exactly one of `workspace` (a workspace id, or its exact folder path) or `folder` (any existing folder).',
  'A `folder` Session joins no DSH workspace, so the user\'s project list stays as it is; a `workspace` Session shows up under that workspace.',
  'Optionally set the Session\'s agent preset (`preset`) and permission mode (`permission`) before it starts; leave them out for the host default.',
  'The session id is written to a dispatch ledger, so its result can be collected later with read_session_transcript.',
  'Use it to open a work line in a project without creating a Bot. The Session belongs to the user, not to any Bot.',
].join(' ') + '\n' + [
  '派会话前先自问三句：',
  '① 要落盘还是回传？落盘就在 prompt 里写死输出路径，只回摘要+路径。',
  '② 只有 Main Bot 能派吗？（值不值得做／范围多大／谁收口提交——三条不全就别派，交清单给 Main Bot）',
  '③ 派出去就管到底：prompt 写清终点（改完→测过→本地 commit），不许写「先别提交」。',
].join('\n')

const READ_DESCRIPTION = [
  'Read back what a Session has said and where it stands, by session id: its latest messages (oldest first) and whether its current turn has already ended.',
  'This is how a dispatched Session\'s result is collected without opening it by hand. Omit `sessionId` to read the most recent dispatch from the ledger.',
  '`last` sets how many messages to bring back (1..200, default 40); older ones remain readable with a bigger value.',
].join(' ')

const LIST_DESCRIPTION = [
  'List the Sessions this plugin dispatched, newest first, with each one\'s state right now: still working, its last turn finished, or a read error.',
  'Use it to see which dispatches are ready to collect; read_session_transcript then gives the content.',
].join(' ')

function statusLine(transcript: Transcript): string {
  // 说清这个状态是宿主直给的，还是从会话自己的事件推出来的 —— 推断不许冒充宿主结论。
  const how = transcript.statusFrom === 'host' ? 'the harness reports this Session as' : ''
  if (transcript.statusFrom === 'host') {
    return transcript.status === 'running'
      ? `still working (${how} running)`
      : `finished (${how} idle)`
  }
  if (transcript.status === 'running') return `still working (turn ${transcript.turn} has not ended, read from the Session's own events)`
  if (transcript.status === 'idle') return `finished (turn ${transcript.turn} ended, read from the Session's own events)`
  return 'the prompt has not started a turn yet'
}

function formatTranscript(transcript: Transcript): string {
  const head = [
    `Session ${transcript.sessionId}${transcript.title === undefined ? '' : ` · "${transcript.title}"`} — ${statusLine(transcript)}`,
    transcript.placement === undefined
      ? ''
      : `place: ${transcript.placement}${transcript.dispatchedAt === undefined ? '' : ` · dispatched ${stamp(transcript.dispatchedAt)}`}`,
    `head seq ${transcript.headSeq}${transcript.newEvents === undefined ? '' : ` (${transcript.newEvents} new event(s) since the last read)`}`,
  ].filter(line => line !== '')

  const body = transcript.messages.map(message => `[${message.role} · ${stamp(message.time)}] ${message.text}`)
  const tail: string[] = []
  if (body.length === 0) tail.push('(no user or assistant message in the range that was read)')
  if (transcript.hasMore) tail.push('(older events exist; call again with a bigger `last` to see more)')
  if (transcript.ledgerError !== undefined) tail.push(`(the dispatch ledger could not be used: ${transcript.ledgerError})`)
  return [...head, ...(body.length === 0 ? [] : body), ...tail].join('\n')
}

export function apply(ctx: HostCtx): void {
  // 启动日志只报「加载那一刻看到了什么」——纯诊断信息。
  // 工具执行路径**不**复用这里的结果：本插件只 inject `tools`，宿主不会为另外几个服务等待就绪
  // （prime-memory dist/index.js:92 注释：声明式注入只会等已声明的服务就绪，不改装配顺序），
  // 所以在 apply() 时把服务拍成快照会引入「加载早于服务就绪 → 永远 host-missing」的失败模式，
  // 而那要用户重启一次才能暴露。执行时现解析。
  const services = resolveServices(ctx)
  const seen = preflight(services)
  const seenRead = preflightRead(services)
  const seenOptions = preflightOptions(services)
  console.log(
    seen.length === 0
      ? '[dsh-session-create] loaded; the host services create_session needs were all present at load.'
      : `[dsh-session-create] loaded; at load MISSING: ${seen.join(', ')} (the tool re-checks on every call)`,
  )
  console.log(
    seenRead.length === 0
      ? '[dsh-session-create] loaded; the host services the read-back tools need were all present at load.'
      : `[dsh-session-create] loaded; at load MISSING for read-back: ${seenRead.join(', ')} (the tools re-check on every call)`,
  )
  // 选项是可选能力：缺了只影响带 preset/permission 的派活，不影响其余调用 —— 单独报，不混进上面两条。
  console.log(
    seenOptions.length === 0
      ? '[dsh-session-create] loaded; the host services the session options need were all present at load.'
      : `[dsh-session-create] loaded; at load MISSING for session options: ${seenOptions.join(', ')} (create_session re-checks on every call)`,
  )

  // 注册是一次性的、必须在加载时完成，所以这一处用当下的解析结果（tools 已在 inject 里，
  // 宿主保证它就绪；仍走 resolveServices 以保留 ctx.get 回退路径）。
  const register = services.tools?.register?.bind(services.tools)

  register?.(
    defineTool({
      name: 'create_session',
      description: CREATE_DESCRIPTION,
      parameters: {
        title: { type: 'string', required: true, description: 'Name of the new Session, as it shows in the user\'s session list.' },
        prompt: { type: 'string', required: true, description: 'The message delivered into the new Session.' },
        workspace: { type: 'string', description: 'A DSH workspace: its id, or its exact folder path. Give this or `folder`, not both.' },
        folder: { type: 'string', description: 'Full path of a folder that exists. The Session works there and joins no DSH workspace. Give this or `workspace`, not both.' },
        preset: { type: 'string', description: 'Agent preset for the new Session, fixed when it is created: `standard`, `minimal`, `ptc` (tools run as code), or `creator`. A name the host does not know is refused and the refusal lists the ones it has. Omit for the host default.' },
        permission: { type: 'string', description: 'Permission mode for the new Session, set with the host\'s own `/permission` command before the prompt: `read-only`, `workspace-write`, or `danger-full-access`. Any other name is refused by the host, which lists the valid ones. Omit for the host default.' },
      },
      output,
      async execute(args: CreateArgs, exec?: unknown) {
        try {
          // 派活人的会话 id 从工具执行上下文取（ds-bot 的形状是 exec.agent.session.id），
          // 记进台账：派出去的会话安静下来后，回执按这个地址投回去（core.installDispatchNotify）。
          const result = await createSessionIn(resolveServices(ctx), args, { dispatcherSessionId: dispatcherSessionOf(exec) })
          const renameNote = result.renamed ? '' : ' (the host would not rename it, so it keeps its default title)'
          const ledgerNote = result.ledgerError === undefined
            ? `Recorded in the dispatch ledger (${result.ledgerPath}); read_session_transcript collects its result later.`
            : `WARNING: the Session is running, but recording it in the dispatch ledger failed (${result.ledgerError}) — keep this session id by hand.`
          const options = [
            result.preset === undefined ? '' : `preset ${result.preset}`,
            result.permission === undefined ? '' : `permission ${result.permission}`,
          ].filter(part => part !== '')
          return [
            `Started a new Session in ${result.placement}.`,
            `- title: ${result.title}${renameNote}`,
            `- session id: ${result.sessionId}`,
            ...(options.length === 0 ? [] : [`- options: ${options.join(' · ')} (permission is what was requested; the Session itself is the record)`]),
            'The prompt is queued in the Session.',
            ledgerNote,
          ].join('\n')
        } catch (error) {
          if (error instanceof SessionCreateError) return `Could not start the Session: ${error.message}`
          const reason = error instanceof Error ? error.message : String(error)
          return `Could not start the Session: ${reason}`
        }
      },
    }),
  )

  register?.(
    defineTool({
      name: 'read_session_transcript',
      description: READ_DESCRIPTION,
      parameters: {
        sessionId: { type: 'string', description: 'The Session to read. Omit to read the most recent dispatch in the ledger.' },
        last: { type: 'number', description: 'How many of the newest messages to bring back (1..200; default 40).' },
      },
      output,
      async execute(args: ReadArgs) {
        try {
          return formatTranscript(await readSessionIn(resolveServices(ctx), args))
        } catch (error) {
          if (error instanceof SessionCreateError) return `Could not read the Session: ${error.message}`
          const reason = error instanceof Error ? error.message : String(error)
          return `Could not read the Session: ${reason}`
        }
      },
    }),
  )

  register?.(
    defineTool({
      name: 'list_dispatched_sessions',
      description: LIST_DESCRIPTION,
      parameters: {
        limit: { type: 'number', description: 'How many of the newest dispatches to show (1..20; default 5).' },
      },
      output,
      async execute(args: { limit?: number }) {
        const live = resolveServices(ctx)
        const missing = preflightRead(live)
        // 台账读不出来时如实带出原因，绝不换一句笼统的话，更不许当成「还没有派送过」。
        let ledger: Awaited<ReturnType<typeof listDispatchedIn>>
        try {
          ledger = await listDispatchedIn(live, args)
        } catch (error) {
          const reason = error instanceof Error ? error.message : String(error)
          return `Could not read the dispatch ledger: ${reason}`
        }
        if (ledger.lines.length === 0) return `No Session has been dispatched from this plugin yet (ledger: ${ledger.ledgerPath}).`
        const header = missing.length === 0
          ? `Dispatched Sessions, newest first (ledger: ${ledger.ledgerPath})`
          : `Dispatched Sessions, newest first (ledger: ${ledger.ledgerPath}; this harness cannot read them back — missing ${missing.join(', ')})`
        const lines = ledger.lines.map((line, index) => {
          const head = `${index + 1}. ${line.record.sessionId} · "${line.record.title}" · ${line.record.placement}`
          const when = `dispatched ${stamp(line.record.dispatchedAt)}`
          if (line.error !== undefined) return `${head}\n   - unreadable: ${line.error} (${when})`
          const state = line.status === 'running'
            ? 'still working'
            : line.status === 'idle'
              ? 'its last turn finished'
              : 'not started'
          const fresh = line.newEvents === undefined ? '' : ` · ${line.newEvents} new event(s) since the last read`
          return `${head}\n   - ${state} · head seq ${line.headSeq}${fresh} · ${when}`
        })
        return [header, ...lines].join('\n')
      },
    }),
  )

  // 完成回执：监听宿主的会话事件面（turn/start · turn/end），只认台账里本插件派出去的会话；
  // 安静满 120 秒且宿主复核为 idle 时，用 controller.prompt(mode:'queue') 投一条短回执给派活人。
  // 这一处挂在 ctx 上而不是工具里 —— 没人调用工具时也要有东西替我们盯着（用户 2026-10-28 要求）。
  installDispatchNotify(ctx)
}
