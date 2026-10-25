import test from 'node:test'
import assert from 'node:assert/strict'
import { randomUUID } from 'node:crypto'
import { mkdtemp, mkdir, writeFile, readFile, rm, symlink } from 'node:fs/promises'
import os from 'node:os'
import path from 'node:path'
import { Observer } from '../lib/observer.js'
import { NavigationHub, nativeBinding } from '../lib/transport.js'

test('adapter implements its pinned protocol fixture without an AgentPet checkout', async () => {
  const fixture = JSON.parse(await readFile(new URL('../protocol/dsh-bridge-v1.json', import.meta.url), 'utf8'))
  const observer = new Observer('/tmp/protocol-fixture', () => {})
  const hub = new NavigationHub(observer)
  const status = await hub.request({ schema: 1, operation: 'status', requestID: randomUUID() })
  assert.equal(status.protocolMajor, fixture.supportedProtocolMajor)
  assert.deepEqual(status.capabilities, fixture.capabilities)
})

test('health works with no tasks, reports capabilities and never navigates or emits task events', async () => {
  const events = [], clientFrames = []
  const observer = new Observer('/tmp/independent-profile', event => events.push(event))
  const hub = new NavigationHub(observer, () => ({ eventConnected: true, eventSocket: '/tmp/isolated-pet.sock' }))
  const requestID = randomUUID()
  const idle = await hub.request({ schema: 1, operation: 'status', requestID })
  assert.equal(idle.requestID, requestID)
  assert.equal(idle.protocolMajor, 1)
  assert.equal(idle.clientCount, 0)
  assert.equal(idle.eventConnected, true)
  assert.ok(idle.capabilities.includes('navigation.v1'))
  hub.register('client-A', frame => { clientFrames.push(frame); return true })
  const ready = await hub.request({ schema: 1, operation: 'status', requestID: randomUUID() })
  assert.equal(ready.clientCount, 1)
  assert.equal(observer.rows.size, 0)
  assert.deepEqual(events, [])
  assert.deepEqual(clientFrames, [])
  assert.equal(hub.pending.size, 0)
  assert.equal((await hub.request({ schema: 2, operation: 'status', requestID })).ok, false)
  assert.equal((await hub.request({ schema: 1, operation: 'exec', requestID })).ok, false)
})

test('adapter owns exact agy binding parsing, account-key variants, ambiguity and bounded file reads', async () => {
  const home = await mkdtemp(path.join(os.tmpdir(), 'dsh-binding-'))
  const profile = path.join(home, 'profiles/desktop'), file = path.join(home, 'agy-link/sessions.json')
  const conversationID = randomUUID(), nativeSessionID = 'session-' + randomUUID()
  try {
    await mkdir(profile, { recursive: true }); await mkdir(path.dirname(file))
    assert.deepEqual(await nativeBinding(profile, conversationID), { result: 'notFound' })
    for (const key of [nativeSessionID, nativeSessionID + ':fixture-account']) {
      await writeFile(file, JSON.stringify({ [key]: { conversationId: conversationID } }))
      const before = await readFile(file)
      assert.deepEqual(await nativeBinding(profile, conversationID), { result: 'matched', nativeSessionID })
      assert.deepEqual(await readFile(file), before)
    }
    await writeFile(file, JSON.stringify({ [nativeSessionID]: { conversationId: conversationID }, ['session-' + randomUUID()]: { conversationId: conversationID } }))
    assert.equal((await nativeBinding(profile, conversationID)).result, 'ambiguous')
    await writeFile(file, JSON.stringify({ '../bad': { conversationId: conversationID } }))
    assert.equal((await nativeBinding(profile, conversationID)).result, 'unavailable')
    await writeFile(file, Buffer.alloc(1048577, 32))
    assert.equal((await nativeBinding(profile, conversationID)).result, 'unavailable')
    await rm(file); await symlink(path.join(home, 'missing'), file)
    assert.equal((await nativeBinding(profile, conversationID)).result, 'unavailable')
  } finally { await rm(home, { recursive: true, force: true }) }
})

test('binding requires current host/profile and never returns bindings for other conversations', async () => {
  const observer = new Observer('/tmp/fixture-no-data', () => { throw Error('must not publish') })
  const hub = new NavigationHub(observer)
  const request = { schema: 1, operation: 'binding', requestID: randomUUID(), hostID: observer.hostID,
    profileID: observer.profileID, conversationID: randomUUID() }
  assert.equal((await hub.request({ ...request, hostID: randomUUID() })).ok, false)
  const result = await hub.request(request)
  assert.equal(result.result, 'notFound')
  assert.equal(result.requestID, request.requestID)
  assert.equal(result.nativeSessionID, undefined)
})
