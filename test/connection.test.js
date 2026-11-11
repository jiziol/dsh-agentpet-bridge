import test from 'node:test'
import assert from 'node:assert/strict'
import net from 'node:net'
import { once } from 'node:events'
import { randomUUID } from 'node:crypto'
import { mkdtemp, mkdir, rm } from 'node:fs/promises'
import { AgentPetBridge } from '../lib/index.js'

test('fresh Lite explicit socket wins over the legacy home; empty config preserves Local', async () => {
  const home = await mkdtemp('/tmp/ap-bridge-connect-')
  const previous = process.env.AGENTPET_LOCAL_HOME
  const litePath = `${home}/.agentpet-lite/agentpet.sock`
  const localHome = `${home}/.agentpet-local`
  const localPath = `${localHome}/agentpet.sock`
  const servers = [], sockets = new Set(), received = [[], []]
  const cleanups = []
  try {
    await mkdir(`${home}/.agentpet-lite`); await mkdir(localHome)
    process.env.AGENTPET_LOCAL_HOME = localHome
    for (const [index, path] of [litePath, localPath].entries()) {
      const server = net.createServer(socket => {
        sockets.add(socket); socket.on('error', () => {})
        let pending = ''
        socket.on('data', bytes => {
          pending += bytes
          let newline
          while ((newline = pending.indexOf('\n')) >= 0) {
            received[index].push(JSON.parse(pending.slice(0, newline)))
            pending = pending.slice(newline + 1)
            server.emit('frame')
          }
        })
      })
      server.listen(path); await once(server, 'listening'); servers.push(server)
    }
    for (const [index, config] of [{ eventSocket: litePath }, { eventSocket: '' }].entries()) {
      const handlers = new Map()
      // Synthetic host-owned services; the real bridge constructor, publisher
      // and status path run against disposable sockets, without a DSH process.
      const ctx = {
        reflect: { provide() {} }, agents: { list: () => [] },
        get: () => ({ dir: `${home}/profile` }), logger: { warn() {} },
        on: (name, handler) => handlers.set(name, handler),
        effect: factory => cleanups.push(factory()),
      }
      const connected = once(servers[index], 'connection', { signal: AbortSignal.timeout(2000) })
      const bridge = new AgentPetBridge(ctx, config)
      await connected; await new Promise(resolve => setImmediate(resolve))
      const status = await bridge.hub.request({ schema: 1, operation: 'status', requestID: randomUUID() })
      assert.equal(status.eventSocket, index === 0 ? litePath : localPath)
      assert.equal(status.eventConnected, true)
      assert.equal(bridge.observer.rows.size, 0)
      const frame = once(servers[index], 'frame', { signal: AbortSignal.timeout(2000) })
      handlers.get('session/event')({ id: `fixture-${index}`, header: {} }, {
        type: 'turn/start', seq: 1, time: Date.now(), data: { turn: 1 },
      })
      await frame
      assert.equal(received[index].at(-1).dsh.phase, 'working')
      if (index === 0) assert.deepEqual(received[1], [])
      await cleanups.pop()()
    }
  } finally {
    if (previous === undefined) delete process.env.AGENTPET_LOCAL_HOME
    else process.env.AGENTPET_LOCAL_HOME = previous
    for (const cleanup of cleanups) await cleanup()
    for (const socket of sockets) socket.destroy()
    for (const server of servers) await new Promise(resolve => server.close(resolve))
    await rm(home, { recursive: true, force: true })
  }
})
