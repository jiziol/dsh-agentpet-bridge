import test from 'node:test'
import assert from 'node:assert/strict'
import vm from 'node:vm'
import { readFile } from 'node:fs/promises'
import { randomUUID } from 'node:crypto'

async function fixture() {
  let plugin, subscriber, cleanup, unmounted = false, opened
  const statuses = new Map(), sent = [], down = [], waiters = []
  let closed = false
  const stream = {
    send: item => sent.push(item),
    dispose: () => { closed = true; for (const resolve of waiters.splice(0)) resolve({ done: true }) },
    [Symbol.asyncIterator]() { return this },
    next: () => down.length ? Promise.resolve({ value: down.shift(), done: false }) : closed ? Promise.resolve({ done: true }) : new Promise(resolve => waiters.push(resolve)),
  }
  const push = frame => waiters.length ? waiters.shift()({ value: frame, done: false }) : down.push(frame)
  const ctx = {
    inject: async (keys, callback) => { assert.deepEqual(Array.from(keys), ['remote.agentPetBridge']); const dispose = await callback(ctx); return { dispose } },
    remote: { $mount: async descriptor => { assert.equal(descriptor.descriptors.length, 1); return () => { unmounted = true } }, agentPetBridge: { watch: () => stream } },
    uiSession: { sessionStatus: { getSnapshot: () => statuses, subscribe: callback => { subscriber = callback; return () => { subscriber = undefined } } } },
    sessions: { list: { getSnapshot: () => ({ byId: { target: {} } }) }, retain: () => ({ ready: Promise.resolve({ session: { getSnapshot: () => ({ openState: 'open' }) } }), release() {} }), retainInfo: () => ({ getSnapshot: () => ({ retainedBy: { mainView: opened === 'target' ? 1 : 0 } }) }) },
    uiWorkspace: { openSession: id => { opened = id } },
    layout: { panelInfo: { getSnapshot: () => ({ activePanelId: null }) } },
  }
  vm.runInNewContext(await readFile(new URL('../lib/client.js', import.meta.url), 'utf8'), {
    window: { __ModuleLoader__: { load: item => { plugin = item.factory(() => { throw new Error('Client must bundle ordinary dependencies') }) } } },
    crypto: { randomUUID }, console, setTimeout, clearTimeout, setInterval, clearInterval,
  })
  cleanup = await plugin.apply(ctx)
  push({ kind: 'hello', hostID: 'host', generation: 'generation', clientID: 'client', profileID: 'profile' })
  const tick = () => new Promise(resolve => setImmediate(resolve))
  await tick()
  return { statuses, sent, push, tick, report: () => subscriber(), close: async () => { await cleanup(); assert.equal(unmounted, true) }, get opened() { return opened } }
}

test('bundled Client reports actual pending, resolves it, and distinguishes free text', async () => {
  const f = await fixture()
  try {
    f.statuses.set('target', {}); f.report(); assert.equal(f.sent.at(-1).pending, null)
    f.statuses.set('target', { pendingInteraction: { key: 'question:target:call', kind: 'question', sessionId: 'target', questions: [{ options: ['A', 'B'] }] } }); f.report()
    assert.equal(f.sent.at(-1).pending.kind, 'choice')
    f.statuses.set('target', { pendingInteraction: { key: 'question:target:reply', kind: 'question', sessionId: 'target', questions: [{}] } }); f.report()
    assert.equal(f.sent.at(-1).pending.kind, 'reply')
    f.statuses.set('target', {}); f.report(); assert.equal(f.sent.at(-1).pending, null)
    const count = f.sent.length; f.report(); assert.equal(f.sent.length, count)
  } finally { await f.close() }
})

test('Client requires exact retained session and rejects stale navigation without changing UI', async () => {
  const f = await fixture()
  const request = { kind: 'navigate', hostID: 'host', generation: 'generation', clientID: 'client', nativeSessionID: 'target', requestID: 'request', expiresAt: Date.now() + 1000 }
  try {
    f.push({ ...request, expiresAt: 0 }); await f.tick(); assert.equal(f.opened, undefined); assert.equal(f.sent.at(-1).ok, false)
    f.push({ ...request, verifyOnly: true }); await f.tick(); assert.equal(f.opened, undefined); assert.equal(f.sent.at(-1).ok, false)
    f.push(request); await f.tick(); assert.equal(f.opened, 'target'); assert.equal(f.sent.at(-1).ok, true)
    f.push({ ...request, verifyOnly: true }); await f.tick(); assert.equal(f.opened, 'target'); assert.equal(f.sent.at(-1).ok, true)
    f.push({ ...request, nativeSessionID: 'missing' }); await f.tick(); assert.equal(f.opened, 'target'); assert.equal(f.sent.at(-1).ok, false)
  } finally { await f.close() }
})

test('Client resync reports resolved pending even when its local cache was unchanged', async () => {
  const f = await fixture()
  try {
    f.statuses.set('target', {}); f.report()
    const count = f.sent.length
    f.push({ kind: 'resync', hostID: 'host', clientID: 'client', generation: 'generation' }); await f.tick()
    assert.equal(f.sent.length, count + 1); assert.equal(f.sent.at(-1).pending, null)
  } finally { await f.close() }
})
