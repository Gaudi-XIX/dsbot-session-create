// 事件形状不是编的：2026-10-26 用 .tmp/probe-blocks.mjs 从**真实**会话存储
// （F:\AgentData\dsh\data\sessions\--F-DSBOT--\session-*.v4.jsonl.zstd，zstd 逐帧解开）里逐字读出字段名与层级，
// 文本一律换成合成内容，此处不含任何真实对话。
// 读到的形状（原文逐字）：
//   turn/start  { turn }
//   turn/end    { turn, reason: { kind } }
//   user/message      { content: [{ type:'text', text }], source: { kind, ... }, role, id }  + surfaceOp
//   assistant/message { turn, step, message: { role, content: [{ type:'text'|'reasoning'|'tool-call', ... }], source, id } }
//   tool/call   { turn, step, callId, name, arguments }
//   tool/result { turn, step, message: { role, source, toolCallId, content, isError, id }, meta }
export const T = 1793012991217

export function realShapedEvents(): unknown[] {
  return [
    { type: 'permission/preset', seq: 0, time: T, data: { preset: 'danger-full-access' } },
    { type: 'session/title', seq: 3, time: T, data: { title: '演示会话', messageSeqs: [], source: { kind: 'auto' } } },
    {
      type: 'agent/inbox/spliced',
      seq: 5,
      time: T,
      data: { target: 'agent', start: 0, inserted: [{ content: [{ type: 'text', text: '交接便条' }], source: { kind: 'handoff' }, role: 'user', id: 'm1' }] },
    },
    { type: 'turn/start', seq: 6, time: T, data: { turn: 1 } },
    { type: 'step/start', seq: 8, time: T, data: { turn: 1, step: 1 } },
    {
      type: 'user/message',
      seq: 10,
      time: T,
      surfaceOp: 'append',
      data: { content: [{ type: 'text', text: '请把结论写到 docs/x.md' }], source: { kind: 'user', form: 'typed', role: 'user' }, role: 'user', id: 'm2' },
    },
    {
      type: 'assistant/message',
      seq: 17,
      time: T,
      surfaceOp: 'append',
      data: { turn: 1, step: 1, message: { role: 'assistant', content: [{ type: 'text', text: '我先看一下现状。' }], source: { kind: 'model', provider: 'deepseek', model: 'demo' }, id: 'm3' } },
    },
    { type: 'tool/call', seq: 26, time: T, data: { turn: 1, step: 1, callId: 'c1', name: 'read', arguments: '{"path":"docs/x.md"}' } },
    {
      type: 'tool/result',
      seq: 27,
      time: T,
      sourceEventSeqs: [26],
      surfaceOp: 'append',
      data: { turn: 1, step: 1, message: { role: 'tool', source: { kind: 'tool', callId: 'c1' }, toolCallId: 'c1', content: [{ type: 'text', text: '文件内容' }], isError: false, id: 'm4' }, meta: {} },
    },
    {
      type: 'assistant/message',
      seq: 30,
      time: T,
      surfaceOp: 'append',
      data: {
        turn: 1,
        step: 2,
        message: {
          role: 'assistant',
          content: [{ type: 'reasoning', text: '先想一下' }, { type: 'tool-call', id: 'c2', name: 'read', arguments: '{}' }],
          source: { kind: 'model' },
          id: 'm5',
        },
      },
    },
    { type: 'step/end', seq: 31, time: T, data: { turn: 1, step: 2 } },
    {
      type: 'assistant/message',
      seq: 33,
      time: T,
      surfaceOp: 'append',
      data: { turn: 1, step: 3, message: { role: 'assistant', content: [{ type: 'text', text: '改完了，结论是 A。' }], source: { kind: 'model' }, id: 'm6' } },
    },
    { type: 'turn/end', seq: 35, time: T, data: { turn: 1, reason: { kind: 'stop' } } },
    { type: 'turn/start', seq: 40, time: T, data: { turn: 2 } },
    {
      type: 'assistant/message',
      seq: 41,
      time: T,
      surfaceOp: 'append',
      data: { turn: 2, step: 1, message: { role: 'assistant', content: [{ type: 'text', text: '再看一处。' }], source: { kind: 'model' }, id: 'm7' } },
    },
  ]
}
