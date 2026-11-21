// 回执落盘账（src/outbox.ts）：只测数据与 IO 这一层——投递逻辑在 src/core.ts 的 createDispatchNotifier 里，
// 那部分由 test/notify.test.ts 覆盖。这里钉的是「账怎么写、怎么读、怎么清」的硬口径。
import { afterAll, beforeAll, describe, expect, test } from 'bun:test'
import { mkdir, readdir, rm, writeFile } from 'node:fs/promises'
import { join } from 'node:path'
import {
  RECEIPT_BACKOFF_MS,
  RECEIPT_MAX_ATTEMPTS,
  RECEIPT_OUTBOX_FILE,
  RECEIPT_RETENTION_MS,
  closeEntry,
  defaultOutboxPath,
  enqueueEntry,
  mutateOutbox,
  pruneEntries,
  readOutbox,
  receiptIdOf,
  retryDelayOf,
  writeOutbox,
  type ReceiptEntry,
} from '../src/outbox'

const TMP_ROOT = join(import.meta.dir, '..', '.tmp')
const OUTBOX_ROOT = join(TMP_ROOT, 'outbox')

function pathFor(name: string): string {
  return join(OUTBOX_ROOT, `${name}.json`)
}

function entryOf(overrides: Partial<ReceiptEntry> = {}): ReceiptEntry {
  return {
    receiptId: receiptIdOf('sess-1', 10),
    sessionId: 'sess-1',
    headSeq: 10,
    dispatcherSessionId: 'chief-1',
    mark: '[DISPATCH DONE]',
    endTime: 2_000_000,
    status: 'pending',
    attempts: 0,
    createdAt: 2_000_000,
    ...overrides,
  }
}

beforeAll(async () => {
  await mkdir(OUTBOX_ROOT, { recursive: true })
})

afterAll(async () => {
  // 自测自清：只删本文件建的账。
  await rm(OUTBOX_ROOT, { force: true, recursive: true })
})

describe('回执落盘账：落点与读写', () => {
  test('落点默认跟随台账目录（测试隔离只要一个 seam）；给了 env 就以 env 为准', () => {
    // 真实宿主：台账在 <DSH_HOME>/bot/session-create/dispatched-sessions.jsonl，账跟它同目录。
    const beside = defaultOutboxPath({}, 'C:\\Users\\someone', 'D:\\dsh\\bot\\session-create\\dispatched-sessions.jsonl')
    expect(beside).toBe(`D:\\dsh\\bot\\session-create\\${RECEIPT_OUTBOX_FILE}`)
    // 没有台账落点时退回与台账同一套「DSH_HOME > ~/.dsh」惯例。
    const fallback = defaultOutboxPath({ DSH_HOME: 'D:\\dsh' }, 'C:\\Users\\someone', '')
    expect(fallback).toBe(`D:\\dsh\\bot\\session-create\\${RECEIPT_OUTBOX_FILE}`)
    // env 覆盖优先于两者。
    expect(defaultOutboxPath({ DSH_SESSION_CREATE_OUTBOX: 'D:\\other\\box.json' }, 'C:\\u', 'D:\\dsh\\x.jsonl')).toBe('D:\\other\\box.json')
  })

  test('文件不存在 = 空账（不是错误）；坏 JSON 必须抛（坏账当成空账等于静默丢债）', async () => {
    expect(await readOutbox(pathFor('absent'))).toEqual([])

    const broken = pathFor('broken')
    await writeFile(broken, '[{"receiptId": "sess-1@10",', 'utf8')
    await expect(readOutbox(broken)).rejects.toThrow()

    const notArray = pathFor('not-array')
    await writeFile(notArray, '{"receiptId": "sess-1@10"}', 'utf8')
    await expect(readOutbox(notArray)).rejects.toThrow()
  })

  test('写回是整份替换且原子：写完读回一致，目录里不留 .tmp 半截文件', async () => {
    const path = pathFor('atomic')
    await writeOutbox(path, [entryOf()])
    expect(await readOutbox(path)).toEqual([entryOf()])

    await writeOutbox(path, [entryOf({ status: 'delivered', closedAt: 2_000_100, deliveredAt: 2_000_000 })])
    expect((await readOutbox(path))[0].status).toBe('delivered')

    const leftovers = (await readdir(OUTBOX_ROOT)).filter(name => name.endsWith('.tmp'))
    expect(leftovers).toEqual([])
  })

  test('并发读改写串行落盘：两次 mutateOutbox 同时记账，两条账都在（不丢、不互相覆盖）', async () => {
    const path = pathFor('mutate')
    await Promise.all([
      mutateOutbox(path, entries => enqueueEntry(entries, entryOf()), 2_000_000),
      mutateOutbox(path, entries => enqueueEntry(entries, entryOf({ receiptId: receiptIdOf('sess-2', 7), sessionId: 'sess-2', headSeq: 7 })), 2_000_000),
    ])
    expect((await readOutbox(path)).map(item => item.receiptId).sort()).toEqual(['sess-1@10', 'sess-2@7'])
  })
})

describe('回执落盘账：记账规则', () => {  test('去重键 = 会话 id @ 终态消息 seq：同一段终态重扫多少次都是同一条', () => {
    expect(receiptIdOf('sess-1', 10)).toBe('sess-1@10')
    expect(receiptIdOf('sess-1', 10)).toBe(receiptIdOf('sess-1', 10))
    expect(receiptIdOf('sess-1', 10)).not.toBe(receiptIdOf('sess-1', 11))
  })

  test('新终态入队：账上多一条 pending，其余照旧', () => {
    const first = enqueueEntry([], entryOf())
    expect(first).toHaveLength(1)
    expect(first[0].status).toBe('pending')
    expect(first[0].attempts).toBe(0)

    const second = enqueueEntry(first, entryOf({ receiptId: receiptIdOf('sess-2', 7), sessionId: 'sess-2', headSeq: 7 }))
    expect(second.map(item => item.receiptId)).toEqual(['sess-1@10', 'sess-2@7'])
  })

  test('同一 receiptId 再来一次 = 多欠了一次投递：累加 attempts，不新增条目', () => {
    const once = enqueueEntry([], entryOf())
    const twice = enqueueEntry(once, entryOf({ createdAt: 2_000_500 }))
    expect(twice).toHaveLength(1)
    expect(twice[0].attempts).toBe(1)
    expect(twice[0].lastAttemptAt).toBe(2_000_500)
  })

  test('同一会话出了新终态：旧账被 superseded 收口，只留新的一条 pending', () => {
    const old = entryOf({ headSeq: 10, endTime: 2_000_000 })
    const fresh = entryOf({ receiptId: receiptIdOf('sess-1', 20), headSeq: 20, endTime: 2_000_100 })
    const kept = closeEntry(
      enqueueEntry(enqueueEntry([], old), fresh),
      'sess-1',
      { status: 'abandoned', abandonedReason: 'superseded', closedAt: 2_000_100 },
      { keep: fresh.receiptId },
    )
    expect(kept.map(item => [item.receiptId, item.status])).toEqual([
      ['sess-1@10', 'abandoned'],
      ['sess-1@20', 'pending'],
    ])
    expect(kept[0].abandonedReason).toBe('superseded')
  })
})

describe('回执落盘账：清理与退避', () => {
  test('保留期只清超过 24 小时的已关闭账；pending 一条都不清', () => {
    const now = 5_000_000_000
    const entries = [
      entryOf({ receiptId: 'pending-old', createdAt: 1 }),
      entryOf({ receiptId: 'closed-fresh', status: 'delivered', closedAt: now - 1_000 }),
      entryOf({ receiptId: 'closed-stale', status: 'abandoned', closedAt: now - RECEIPT_RETENTION_MS - 1 }),
    ]
    expect(pruneEntries(entries, now).map(item => item.receiptId)).toEqual(['pending-old', 'closed-fresh'])
  })

  test('退避档：前 5 次按 30s/60s/120s/300s/600s，第 6 次起固定 600s；单条上限 40 次', () => {
    expect([0, 1, 2, 3, 4, 5, 39].map(attempts => retryDelayOf(attempts))).toEqual([...RECEIPT_BACKOFF_MS, 600_000, 600_000])
    expect(RECEIPT_MAX_ATTEMPTS).toBe(40)
  })
})
