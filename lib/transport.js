import net from 'node:net'
import { chmod, lstat, mkdir, mkdtemp, rm, open } from 'node:fs/promises'
import { readFileSync } from 'node:fs'
import path from 'node:path'
import os from 'node:os'
import { randomUUID } from 'node:crypto'
import { validID } from './observer.js'

const uuidPattern = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i
const packageVersion = JSON.parse(readFileSync(new URL('../package.json', import.meta.url), 'utf8')).version

// Host-specific persisted formats are confined to the adapter, never read by AgentPet.
export async function nativeBinding(profilePath, conversationID) {
  if (typeof conversationID !== 'string' || !uuidPattern.test(conversationID)) return { result: 'notFound' }
  const filename = path.resolve(profilePath, '../../agy-link/sessions.json')
  let file
  try {
    const info = await lstat(filename)
    if (!info.isFile() || info.uid !== process.getuid() || info.size > 1048576) return { result: 'unavailable' }
    file = await open(filename, 'r')
    const actual = await file.stat()
    if (actual.ino !== info.ino || actual.dev !== info.dev) return { result: 'unavailable' }
    const bytes = Buffer.alloc(1048577)
    const { bytesRead } = await file.read(bytes, 0, bytes.length, 0)
    if (bytesRead > 1048576) return { result: 'unavailable' }
    const entries = JSON.parse(bytes.subarray(0, bytesRead).toString('utf8'))
    if (!entries || Array.isArray(entries) || typeof entries !== 'object' || Object.keys(entries).length > 4096) return { result: 'unavailable' }
    const matches = new Set()
    for (const [key, value] of Object.entries(entries)) {
      if (value?.conversationId !== conversationID) continue
      const pieces = key.split(':')
      if (pieces.length > 2 || pieces.some(p => !p) || !pieces[0].startsWith('session-') || !uuidPattern.test(pieces[0].slice(8))) return { result: 'unavailable' }
      matches.add(pieces[0])
    }
    if (matches.size > 1) return { result: 'ambiguous' }
    return matches.size ? { result: 'matched', nativeSessionID: [...matches][0] } : { result: 'notFound' }
  } catch (error) { return { result: error?.code === 'ENOENT' ? 'notFound' : 'unavailable' } }
  finally { await file?.close() }
}

/** AgentPet absence never delays a DSH lifecycle listener. */
export class Publisher {
  constructor(socketPath, onConnect) {
    this.path = socketPath; this.onConnect = onConnect; this.queue = []; this.closed = false; this.retry = null
    // EventSocketServer gives each next frame a five-second deadline. Keep the
    // observer pipe alive without changing any session or activity revision.
    this.keepalive = setInterval(() => {
      if (this.connected) this.send({ sessionId: 'dsh-bridge', agentKind: 'dsh', eventName: 'dsh/keepalive', timestamp: Date.now() / 1000 })
    }, 3000); this.keepalive.unref()
    this.connect()
  }
  send(event) {
    const frame = JSON.stringify(event) + '\n'
    if (Buffer.byteLength(frame) > 32768) return false
    if (!this.socket || this.socket.destroyed || !this.connected) { this.gap = true; return false }
    if (this.queue.length >= 256) {
      this.gap = true; this.socket.destroy(); return false
    }
    this.queue.push(frame); this.flush(); return true
  }
  flush() {
    while (this.ready && this.queue.length) {
      if (!this.socket.write(this.queue.shift())) { this.ready = false; break }
    }
  }
  async connect() {
    if (this.closed) return
    try {
      const stat = await lstat(this.path)
      if (this.closed) return
      if (!stat.isSocket() || stat.uid !== process.getuid()) throw new Error('unsafe event endpoint')
      const socket = net.createConnection(this.path); this.socket = socket
      socket.on('connect', () => {
        if (this.closed) { socket.destroy(); return }
        this.connected = true; this.ready = true; const gap = Boolean(this.gap); this.gap = false; this.queue = []
        this.onConnect(gap)
      })
      socket.on('drain', () => { this.ready = true; this.flush() })
      socket.on('error', () => {})
      socket.on('close', () => {
        this.connected = false; this.ready = false; this.queue = []; this.gap = true; this.schedule()
      })
    } catch { this.schedule() }
  }
  schedule() {
    if (this.closed || this.retry) return
    this.retry = setTimeout(() => { this.retry = null; this.connect() }, 1000); this.retry.unref()
  }
  close() { this.closed = true; clearTimeout(this.retry); clearInterval(this.keepalive); this.socket?.destroy(); this.queue = [] }
}

/** Per-instance private directory provides the OS same-user access boundary. */
export async function privateSocketDirectory(root = `/tmp/agentpet-dsh-${process.getuid()}`) {
  await mkdir(root, { mode: 0o700 }).catch(error => { if (error.code !== 'EEXIST') throw error })
  const stat = await lstat(root)
  if (!stat.isDirectory() || stat.isSymbolicLink() || stat.uid !== process.getuid() || (stat.mode & 0o777) !== 0o700) {
    throw new Error('unsafe bridge socket directory')
  }
  const directory = await mkdtemp(path.join(root, 'h-')); await chmod(directory, 0o700)
  return directory
}

/** Only navigate is accepted; the bridge has no approval, answer or exec route. */
export class NavigationHub {
  constructor(observer, health = () => ({ eventConnected: false, eventSocket: '' })) {
    this.observer = observer; this.health = health; this.clients = new Map(); this.pending = new Map(); this.connections = new Set()
  }
  resyncUnique() {
    if (this.clients.size !== 1) return
    const client = [...this.clients.values()][0]
    client.push({ kind: 'resync', hostID: this.observer.hostID, profileID: this.observer.profileID,
      clientID: client.clientID, generation: client.generation })
  }
  register(clientID, push, close = () => {}) {
    if (!validID(clientID) || this.clients.size >= 4 || this.clients.has(clientID)) throw new Error('client registration rejected')
    const record = { clientID, push, close, generation: randomUUID() }; this.clients.set(clientID, record)
    return () => {
      if (this.clients.get(clientID) !== record) return
      this.clients.delete(clientID)
      for (const item of this.pending.values()) if (item.client === record) item.finish(false, 'client-disconnected')
      this.resyncUnique()
    }
  }
  request(request) {
    const o = this.observer
    if (request?.schema === 1 && validID(request.requestID)) {
      if (request.operation === 'status') return Promise.resolve({
        schema: 1, requestID: request.requestID, profileID: o.profileID, hostID: o.hostID,
        hostStartedAt: o.hostStartedAt, protocolMajor: 1,
        capabilities: ['lifecycle.v1', 'pending.v1', 'navigation.v1', 'speech.v1', 'bindings.v1'],
        packageVersion, clientCount: this.clients.size, ...this.health(),
      })
      if (request.operation === 'binding' && request.hostID === o.hostID && request.profileID === o.profileID) {
        return nativeBinding(o.profilePath, request.conversationID).then(result => ({
          schema: 1, requestID: request.requestID, profileID: o.profileID, hostID: o.hostID, ...result,
        }))
      }
    }
    if (request?.schema !== 1 || request.operation !== 'navigate' || !validID(request.requestID) ||
        request.hostID !== o.hostID || request.profileID !== o.profileID || !validID(request.nativeSessionID) ||
        (request.verifyOnly !== undefined && typeof request.verifyOnly !== 'boolean')) {
      return Promise.resolve({ ok: false, reason: 'target-mismatch' })
    }
    if (this.clients.size !== 1) return Promise.resolve({ ok: false, reason: 'client-ambiguous-or-absent' })
    if (this.pending.size >= 8 || this.pending.has(request.requestID)) return Promise.resolve({ ok: false, reason: 'busy' })
    const client = [...this.clients.values()][0]
    return new Promise(resolve => {
      const finish = (ok, reason) => {
        if (!this.pending.delete(request.requestID)) return
        clearTimeout(item.timer)
        resolve({ schema: 1, requestID: request.requestID, hostID: o.hostID, profileID: o.profileID,
          nativeSessionID: request.nativeSessionID, clientID: client.clientID, generation: client.generation, ok, reason })
      }
      const item = { client, request, finish, timer: setTimeout(() => finish(false, 'timeout'), 3000) }
      this.pending.set(request.requestID, item)
      if (!client.push({ kind: 'navigate', requestID: request.requestID, hostID: o.hostID, profileID: o.profileID, nativeSessionID: request.nativeSessionID, expiresAt: Date.now() + 2800, clientID: client.clientID, generation: client.generation, verifyOnly: request.verifyOnly === true })) finish(false, 'backpressure')
    })
  }
  acknowledge(clientID, ack) {
    const item = this.pending.get(ack?.requestID)
    if (!item || item.client !== this.clients.get(clientID) || ack.hostID !== this.observer.hostID ||
        ack.generation !== item.client.generation || ack.nativeSessionID !== item.request.nativeSessionID) return false
    item.finish(ack.ok === true, ack.ok === true ? 'selected' : 'selection-failed'); return true
  }
  async listen() {
    this.directory = await privateSocketDirectory()
    this.path = path.join(this.directory, 'nav.sock')
    if (Buffer.byteLength(this.path) >= 100) throw new Error('navigation socket path too long')
    this.server = net.createServer(socket => {
      if (this.connections.size >= 8) { socket.destroy(); return }
      this.connections.add(socket); let buffer = Buffer.alloc(0); let used = false
      socket.setTimeout(3500, () => socket.destroy())
      socket.on('error', () => {}); socket.on('close', () => this.connections.delete(socket))
      socket.on('data', async data => {
        if (used) return
        buffer = Buffer.concat([buffer, data])
        if (buffer.length > 8192) { socket.destroy(); return }
        const newline = buffer.indexOf(10)
        if (newline < 0) return
        used = true
        try { socket.end(JSON.stringify(await this.request(JSON.parse(buffer.subarray(0, newline)))) + '\n') }
        catch { socket.end('{"ok":false,"reason":"invalid-frame"}\n') }
      })
    })
    await new Promise((resolve, reject) => { this.server.once('error', reject); this.server.listen(this.path, resolve) })
    await chmod(this.path, 0o600); this.observer.navigationSocket = this.path
  }
  async close() {
    for (const item of this.pending.values()) item.finish(false, 'host-disposed')
    for (const client of this.clients.values()) client.close()
    this.clients.clear(); for (const socket of this.connections) socket.destroy()
    if (this.server) await new Promise(resolve => this.server.close(resolve))
    if (this.directory) await rm(this.directory, { recursive: true, force: true })
  }
}

/** Small cancellable pull queue for a Client stream. Full means disconnect and resync. */
export class Mailbox {
  constructor() { this.frames = []; this.closed = false }
  push(frame) {
    if (this.closed || this.frames.length >= 16) return false
    this.frames.push(frame); this.wake?.(); return true
  }
  close() { this.closed = true; this.wake?.() }
  async *iterate(signal) {
    const abort = () => this.close(); signal.addEventListener('abort', abort, { once: true })
    try {
      while (!this.closed && !signal.aborted) {
        if (this.frames.length) yield this.frames.shift()
        else await new Promise(resolve => { this.wake = resolve })
      }
    } finally { signal.removeEventListener('abort', abort); this.close() }
  }
}
