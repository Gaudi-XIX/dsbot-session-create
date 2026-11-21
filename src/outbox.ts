// 回执待办账（receipt outbox）：把「这一单还欠派活方一条回执」写进盘上。
//
// 为什么要有它：0.11 的完成回执把判定与待办都放在进程内存里（`pending` / `notified` 两个集合），
// 宿主一重启、会话被重启掐断，这条债就随进程一起蒸发了 —— 而「宿主重启过」恰恰是派活方最需要
// 回执的时刻。这个模块只解决一件事：让「欠谁一条回执」离开内存。
//
// 三条边界，别在别处重复实现：
//   ① **只有数据与 IO**。投不投、投给谁、什么时候投，全在 `src/core.ts` 的门格子（createDispatchNotifier）；
//      这里不做任何宿主调用，也不认终态标记。
//   ② **坏账宁可报错，不当空账**。读到坏 JSON 就抛：把它当空数组等于把欠着的回执悄悄丢掉，
//      正是这个模块要治的病。只有「文件不存在」才算没有账（仓里第一次跑就是这样）。
//   ③ **写账是原子的**：先写 `<path>.<pid>.tmp` 再 rename（照 `src/autoresume.ts:93 writeAtomicDefault`）。
//      同一路径的读改写走模块内的串行队列，两个调用不会互相盖掉对方刚写的那一条。
import { mkdir, readFile, rename, writeFile } from 'node:fs/promises'
import { dirname, join } from 'node:path'

/** 账文件名。它跟派送台账同目录（`src/core.ts` 的 defaultLedgerPath 那一边算目录）。 */
export const RECEIPT_OUTBOX_FILE = 'receipt-outbox.json'
/** 换个地方账：给到就整份用它（测试与手工排查用，不必改 DSH_HOME）。 */
export const RECEIPT_OUTBOX_ENV = 'DSH_SESSION_CREATE_OUTBOX'
/** `=1` 时不再往盘上记账：进程内行为与 0.11 一致（静默窗口照旧投），重启后不补投。 */
export const RECEIPT_OUTBOX_DISABLE_ENV = 'DSH_SESSION_CREATE_OUTBOX_DISABLE'
/** 重试退避：第 0 次到点的重试等 30 秒，之后逐级拉长，到顶后固定 10 分钟一跳。 */
export const RECEIPT_BACKOFF_MS = [30_000, 60_000, 120_000, 300_000, 600_000] as const
/** 一条账最多试这么多次就认输：40 次 × 10 分钟 ≈ 7 小时，够跨过一轮长重启，又不至于永远挂着。 */
export const RECEIPT_MAX_ATTEMPTS = 40
/** 已收口的账（delivered / abandoned）留 24 小时：够人工查「昨晚那条到底投没投」，又不让文件无限长。 */
export const RECEIPT_RETENTION_MS = 86_400_000

export type ReceiptStatus = 'pending' | 'delivered' | 'abandoned'
/** 为什么放弃：被同一单更新的终态顶掉 / 派活方会话已经没了 / 试满了 max-attempts。 */
export type ReceiptAbandonReason = 'superseded' | 'dispatcher-gone' | 'max-attempts'

/** 一条待办账。`headSeq` 是那一轮终态消息在会话里的事件序号，与 `sessionId` 一起充当去重键。 */
export type ReceiptEntry = {
  receiptId: string
  sessionId: string
  headSeq: number
  dispatcherSessionId?: string
  returnTo?: string
  mark: string
  turn?: number
  reason?: string
  endTime: number
  status: ReceiptStatus
  attempts: number
  createdAt: number
  lastAttemptAt?: number
  deliveredAt?: number
  closedAt?: number
  abandonedReason?: ReceiptAbandonReason
}

/** 去重键：同一单（会话）同一段终态（消息序号）只记一条。 */
export function receiptIdOf(sessionId: string, headSeq: number): string {
  return `${sessionId}@${headSeq}`
}

/**
 * 账落在哪：默认跟派送台账同目录 —— 台账路径已经吃掉了 `DSH_SESSION_CREATE_LEDGER` 与
 * `DSH_HOME` 两个变量，账跟着它走，测试与运维只需设一个变量就能把两样一起搬走。
 * 台账路径为空时退回 `<DSH_HOME 或 ~/.dsh>/bot/session-create/receipt-outbox.json`。
 */
export function defaultOutboxPath(env: Record<string, string | undefined>, home: string, ledgerPath: string): string {
  const override = (env[RECEIPT_OUTBOX_ENV] ?? '').trim()
  if (override !== '') return override
  if (ledgerPath !== '') return join(dirname(ledgerPath), RECEIPT_OUTBOX_FILE)
  const dshHome = (env.DSH_HOME ?? '').trim() === '' ? join(home, '.dsh') : env.DSH_HOME
  return join(dshHome as string, 'bot', 'session-create', RECEIPT_OUTBOX_FILE)
}

function isReceiptEntry(value: unknown): value is ReceiptEntry {
  if (typeof value !== 'object' || value === null) return false
  const entry = value as Partial<ReceiptEntry>
  const status = entry.status
  return (
    typeof entry.receiptId === 'string' &&
    typeof entry.sessionId === 'string' &&
    typeof entry.headSeq === 'number' &&
    typeof entry.endTime === 'number' &&
    (status === 'pending' || status === 'delivered' || status === 'abandoned')
  )
}

/** 读账。文件不存在 ⇒ 空账；坏 JSON / 不是数组 ⇒ 抛（见文件头 ②）。 */
export async function readOutbox(path: string): Promise<ReceiptEntry[]> {
  let text: string
  try {
    text = await readFile(path, 'utf8')
  } catch (error) {
    if ((error as NodeJS.ErrnoException | undefined)?.code === 'ENOENT') return []
    throw error
  }
  if (text.trim() === '') return []
  const parsed: unknown = JSON.parse(text)
  if (!Array.isArray(parsed)) throw new Error(`${path} is not a receipt outbox (expected a JSON array of entries)`)
  // 单条坏行丢掉、其余照用：坏一条不该把整份账连坐，但整份坏必须抛（上面两条）。
  return parsed.filter(isReceiptEntry)
}

/** 原子写：tmp + rename，半截文件不会出现在账位上。 */
export async function writeOutbox(path: string, entries: ReceiptEntry[]): Promise<void> {
  await mkdir(dirname(path), { recursive: true })
  const tmp = `${path}.${process.pid}.tmp`
  await writeFile(tmp, `${JSON.stringify(entries, null, 2)}\n`, 'utf8')
  await rename(tmp, path)
}

const writing = new Map<string, Promise<unknown>>()

/**
 * 读改写一条账（串行）：并发的两次调用按调用顺序落盘，后一次读到的一定是前一次写下的。
 * 写之前顺手按 `pruneEntries` 清理过期账。
 */
export async function mutateOutbox(
  path: string,
  mutate: (entries: ReceiptEntry[]) => ReceiptEntry[],
  now = Date.now(),
): Promise<ReceiptEntry[]> {
  const previous = writing.get(path) ?? Promise.resolve()
  const next = previous.then(async () => {
    const current = await readOutbox(path)
    const updated = pruneEntries(mutate(current), now)
    // 没变就不写：收口一个本来就不欠的单不该凭空造出一份账文件（也不该反复重写它）。
    if (JSON.stringify(updated) !== JSON.stringify(current)) await writeOutbox(path, updated)
    return updated
  })
  // 链上只留「已结束」这一事实，不让一次失败把后续写全部带进拒绝态。
  writing.set(
    path,
    next.then(
      () => undefined,
      () => undefined,
    ),
  )
  return next
}

/** 记账。同一 `receiptId` 已经在账上就只累加一次尝试（不重复入账）。 */
export function enqueueEntry(entries: ReceiptEntry[], entry: ReceiptEntry): ReceiptEntry[] {
  const found = entries.find(item => item.receiptId === entry.receiptId)
  if (found === undefined) return [...entries, entry]
  return entries.map(item =>
    item.receiptId === entry.receiptId
      ? { ...item, attempts: item.attempts + 1, lastAttemptAt: item.lastAttemptAt ?? entry.createdAt }
      : item,
  )
}

/**
 * 收口：把这一单还挂着的待办账一次性标成 delivered / abandoned。
 * `options.only` 只收指定那一条；`options.keep` 收这一单的**其它**账（留下指定那条，用于「新终态顶掉旧终态」）。
 */
export function closeEntry(
  entries: ReceiptEntry[],
  sessionId: string,
  patch: {
    status: 'delivered' | 'abandoned'
    closedAt: number
    deliveredAt?: number
    abandonedReason?: ReceiptAbandonReason
  },
  options: { only?: string; keep?: string } = {},
): ReceiptEntry[] {
  return entries.map(entry => {
    if (entry.sessionId !== sessionId || entry.status !== 'pending') return entry
    if (options.only !== undefined && entry.receiptId !== options.only) return entry
    if (options.keep !== undefined && entry.receiptId === options.keep) return entry
    return { ...entry, ...patch }
  })
}

/** 只留还欠着的，加上 24 小时内收口的（更早的收口账没有查证价值）。 */
export function pruneEntries(entries: ReceiptEntry[], now: number): ReceiptEntry[] {
  return entries.filter(entry => {
    if (entry.status === 'pending') return true
    if (typeof entry.closedAt !== 'number') return true
    return now - entry.closedAt < RECEIPT_RETENTION_MS
  })
}

/** 第 `attempts` 次重试等多久。越界的降到最后一档（固定 10 分钟一跳）。 */
export function retryDelayOf(attempts: number, backoff: readonly number[] = RECEIPT_BACKOFF_MS): number {
  const table = backoff.length === 0 ? RECEIPT_BACKOFF_MS : backoff
  const index = Math.min(Math.max(Math.trunc(attempts), 0), table.length - 1)
  return table[index]
}

/** 账上还欠着的（可按会话过滤）。不传 `sessionId` 就是全部。 */
export function pendingOf(entries: ReceiptEntry[], sessionId?: string): ReceiptEntry[] {
  return entries.filter(entry => entry.status === 'pending' && (sessionId === undefined || entry.sessionId === sessionId))
}
