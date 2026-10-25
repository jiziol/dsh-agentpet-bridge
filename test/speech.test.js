import test from 'node:test'
import assert from 'node:assert/strict'
import { Observer } from '../lib/observer.js'
const session = { id: 'native-A', header: {} }
function fixture() {
  const frames = [], o = new Observer('/tmp/test-profile', f => frames.push(f), () => 100000)
  o.consume(session, { type: 'turn/start', seq: 0, time: 100000, data: { turn: 1 } })
  return { o, frames }
}
function message(seq = 1, extra = {}) {
  return { type: 'assistant/message', seq, time: 100000, surfaceOp: 'append',
    data: { turn: 1, step: 0, message: { role: 'assistant', source: { kind: 'model', provider: 'fixture', model: 'fixture' }, content: [{ type: 'text', text: '好的。正在检查窗口布局。' }] } }, ...extra }
}
const speech = frames => frames.filter(f => f.schema === 'agentpet.dsh.speech.v1')
test('only committed public text crosses a separate channel without accessing private blocks', () => {
  const { o, frames } = fixture(), e = message()
  e.data.stream = new Proxy({}, { get() { throw Error('private stream read') } })
  e.data.message.content.unshift({ type: 'reasoning', get text() { throw Error('reasoning read') } })
  e.data.message.content.push({ type: 'tool-call', get arguments() { throw Error('arguments read') } })
  o.consume(session, e)
  assert.equal(speech(frames)[0].text, '好的。正在检查窗口布局。')
  assert.equal(frames.at(-2).eventName, 'dsh/observation')
  assert.equal(speech(frames)[0].observation_revision, frames.at(-2).dsh.revision)
  assert.ok(frames.filter(f => !f.schema).every(f => !JSON.stringify(f).includes('正在检查窗口布局')))
})
test('baseline, stale, future, interrupted, wrong role, wrong turn and attempts do not publish', () => {
  for (const change of [e => { e.type = 'assistant/attempt' }, e => { e.data.turn = 2 },
    e => { e.data.interrupted = true }, e => { e.data.message.role = 'user' },
    e => { e.time = 95000 }, e => { e.time = 103000 }, e => { e.surfaceOp = { replace: [0] } }]) {
    const { o, frames } = fixture(), e = message(); change(e); o.consume(session, e); assert.equal(speech(frames).length, 0)
  }
  const { o, frames } = fixture(); o.consume(session, message(), true); o.rebaseline(true); o.heartbeat()
  assert.equal(speech(frames).length, 0)
})
test('duplicates do not replay; deletion and rewrites withdraw and reconnection never replays text', () => {
  for (const type of ['feedback/message-put', 'feedback/message-delete', 'compaction/summary']) {
    const { o, frames } = fixture(); o.consume(session, message()); o.consume(session, message())
    assert.equal(speech(frames).length, 1)
    o.consume(session, { type, seq: 2, time: 100000, data: {}, ...(type === 'compaction/summary' ? { surfaceOp: { replace: [0] } } : {}) })
    assert.equal(speech(frames).at(-1).mode, 'withdraw'); assert.equal(speech(frames).at(-1).text, '')
    o.rebaseline(true); o.heartbeat(); assert.equal(speech(frames).length, 2)
  }
})
test('cancel or failed result withdraws; late old-turn and subsequent stopped text cannot resurrect', () => {
  for (const reason of [{kind:'aborted',reason:{kind:'user'}},{kind:'error'}]) {
    const { o, frames } = fixture(); o.consume(session, message())
    o.consume(session, {type:'turn/end',seq:2,time:100000,data:{turn:1,reason}})
    assert.equal(speech(frames).at(-1).mode, 'withdraw')
    o.consume(session, message(3)); assert.equal(speech(frames).length, 2)
    o.consume(session,{type:'turn/start',seq:4,time:100000,data:{turn:2}})
    o.consume(session,message(5)); assert.equal(speech(frames).length, 2)
  }
})
test('empty or reasoning-only text rejected; utf8 payload is bounded', () => {
  const {o,frames}=fixture(), e=message(); e.data.message.content=[{type:'reasoning',text:'SECRET'}]
  o.consume(session,e); assert.equal(speech(frames).length,0)
  const huge=message(2); huge.data.message.content=[{type:'text',text:'👨‍👩‍👧‍👦'.repeat(10000)}]
  o.consume(session,huge); assert.ok(Buffer.byteLength(speech(frames).at(-1).text)<=2048)
  assert.ok(Buffer.byteLength(JSON.stringify(speech(frames).at(-1)))<8192)
})
