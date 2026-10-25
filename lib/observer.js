import { createHash, randomUUID } from 'node:crypto'

export const validID = value => typeof value === 'string' && /^[A-Za-z0-9_.:-]{1,160}$/.test(value)
// Keep a bounded history tail, retaining the latest lifecycle and metadata
// anchors even when a long active turn starts more than 2048 events ago.
export function baselineEvents(events) {
  const anchors = new Map()
  for (let i = events.length - 1; i >= 0 && anchors.size < 4; i--) {
    const event = events[i]
    if (['turn/start', 'turn/end', 'session/title', 'request/header'].includes(event.type) && !anchors.has(event.type)) anchors.set(event.type, event)
  }
  const selected = new Map(events.slice(-2048).map(event => [event.seq, event]))
  for (const event of anchors.values()) selected.set(event.seq, event)
  return [...selected.values()].sort((a, b) => a.seq - b.seq)
}
const label = value => typeof value === 'string' ? value.replace(/[\x00-\x1f\x7f]/g, '').slice(0, 240) : undefined
const resultOf = reason => {
  if (reason?.kind === 'completed') return 'completed'
  if (reason?.kind === 'error') return 'failed'
  if (reason?.kind === 'aborted' && reason.reason?.kind === 'user') return 'cancelled'
  return 'unknown'
}

/** Metadata fold plus a separate volatile public-text channel; no prose in snapshots. */
export class Observer {
  constructor(profilePath, publish, now = () => Date.now()) {
    this.profilePath = profilePath
    this.profileID = createHash('sha256').update(profilePath).digest('hex').slice(0, 24)
    this.hostID = randomUUID()
    this.hostStartedAt = now() / 1000
    this.now = now
    this.publish = publish
    this.rows = new Map()
  }
  ensure(session) {
    if (!validID(session?.id)) return null
    if (!this.rows.has(session.id)) {
      if (this.rows.size >= 128) {
        const idle = [...this.rows].find(([, row]) => row.phase === 'done' && row.pending.length === 0)
        if (!idle) return null
        this.rows.delete(idle[0])
      }
      this.rows.set(session.id, { nativeSessionID: session.id, revision: 0, nativeSeq: -1,
        turn: null, phase: 'idle', result: null, pending: [], startedAt: null, endedAt: null,
        title: label(session.header?.title), project: label(session.header?.cwd), speechItem: null, speechRevision: 0 })
    }
    return this.rows.get(session.id)
  }
  consume(session, event, baseline = false, emit = true) {
    const row = this.ensure(session)
    if (!row || !Number.isSafeInteger(event?.seq) || event.seq <= row.nativeSeq) return
    row.nativeSeq = event.seq
    const at = Number.isFinite(event.time) ? event.time / 1000 : this.now() / 1000
    let changed = false
    const data = event.data
    if (event.type === 'turn/start' && Number.isSafeInteger(data?.turn)) {
      row.speechItem = null
      row.turn = data.turn; row.phase = 'working'; row.result = null; row.pending = []
      row.startedAt = at; row.endedAt = null; row.message = '正在处理任务'; changed = true
    } else if (event.type === 'turn/end' && row.turn === data?.turn && row.endedAt === null) {
      row.result = resultOf(data.reason); row.phase = 'done'; row.endedAt = at
      if (row.result !== 'completed') row.pending = []
      row.message = { completed: '本轮已完成', failed: '任务结束，发生错误', cancelled: '任务已停止', unknown: '任务结果未知' }[row.result]
      changed = true
    } else if (event.type === 'session/title') {
      row.title = label(data?.title); changed = true
    } else if (event.type === 'request/header') {
      row.model = label(data?.header?.config?.model); changed = true
    } else if (event.type === 'tool/call' && row.endedAt === null && row.turn === data?.turn) {
      const tool = label(data?.name)
      row.message = tool ? `正在调用 ${tool}` : '正在执行工具'; changed = true
    } else if (event.type === 'tool/result' && row.endedAt === null && row.turn === data?.turn) {
      row.message = '正在处理任务'; changed = true
    }
    // Metadata belongs to the Session header, not model-generated prose.
    row.project = label(session.header?.cwd) ?? row.project
    if (emit && changed && row.turn !== null) this.emit(row, baseline)
    if (emit && !baseline) this.visibleText(row, event)
  }
  visibleText(row, event) {
    const data = event.data
    // Replacements, deletion and content projection changes withdraw the
    // short preview conservatively. Never replay a replacement history node.
    if (event.type === 'feedback/message-put' || event.type === 'feedback/message-delete' ||
        event.type === 'image/offload' || event.surfaceOp && event.surfaceOp !== 'append' ||
        event.type === 'turn/end' && row.result !== 'completed') {
      if (row.speechItem !== null) {
        this.emit(row)
        this.speech(row, event, row.speechItem, '', 'withdraw')
      }
      row.speechItem = null
      return
    }
    if (event.type !== 'assistant/message' || row.phase !== 'working' || row.result !== null ||
        data?.turn !== row.turn || !Number.isSafeInteger(data?.step) || data.step < 0 ||
        event.surfaceOp !== 'append' || data.interrupted === true ||
        data.message?.role !== 'assistant' || data.message?.source?.kind !== 'model' ||
        !Array.isArray(data.message.content) || !Number.isFinite(event.time) ||
        event.time / 1000 < row.startedAt || this.now() - event.time < -2000 || this.now() - event.time >= 5000) return
    // Access only public text blocks, never stream/replayState, thinking or arguments.
    let text = ''
    for (const block of data.message.content) {
      if (block.type !== 'text' || typeof block.text !== 'string') continue
      text += Array.from(block.text.slice(0, 2048)).slice(0, 320).join('')
      if (Array.from(text).length >= 320) break
    }
    text = Array.from(text.replace(/[\x00-\x08\x0b\x0c\x0e-\x1f\x7f]/g, '')).slice(0, 320).join('')
    while (Buffer.byteLength(text) > 2048) text = Array.from(text).slice(0, -1).join('')
    if (!text.trim()) return
    // Publish current lifecycle metadata first, on the same ordered socket.
    this.emit(row)
    row.speechItem = String(event.seq)
    this.speech(row, event, row.speechItem, text, 'snapshot')
  }
  speech(row, event, item, text, mode) {
    this.publish({ schema: 'agentpet.dsh.speech.v1', profile_id: this.profileID,
      host_id: this.hostID, host_started_at: this.hostStartedAt,
      session_id: row.nativeSessionID, turn: row.turn, native_seq: event.seq,
      observation_revision: row.revision, item_id: item, revision: ++row.speechRevision,
      timestamp: event.time / 1000, role: 'assistant', part_type: 'text', mode, text })
  }
  pending(nativeID, pending, baseline = false) {
    const row = this.rows.get(nativeID)
    if (!row || (row.result && row.result !== 'completed')) return
    const next = pending === null ? [] : [pending]
    if (JSON.stringify(next) === JSON.stringify(row.pending)) return
    row.pending = next
    this.emit(row, baseline)
  }
  emit(row, baseline = false, heartbeat = false, gap = false) {
    row.revision++
    this.publish({ sessionId: `dsh:${this.profileID}:${row.nativeSessionID}`, agentKind: 'dsh', eventName: 'dsh/observation',
      timestamp: this.now() / 1000, title: row.title, project: row.project, model: row.model,
      message: row.message, dsh: { schema: 1, profileID: this.profileID, hostID: this.hostID,
        hostStartedAt: this.hostStartedAt, nativeSessionID: row.nativeSessionID, revision: row.revision,
        nativeSeq: row.nativeSeq, turn: row.turn, phase: row.phase, result: row.result, pending: row.pending,
        startedAt: row.startedAt, endedAt: row.endedAt, baseline, heartbeat, gap,
        navigationSocket: this.navigationSocket ?? null } })
  }
  rebaseline(gap = false) {
    // Reconnect never retransmits a preview or keeps an old withdrawal target.
    for (const row of this.rows.values()) row.speechItem = null
    for (const row of this.rows.values()) if (row.turn !== null) this.emit(row, true, false, gap)
  }
  heartbeat() {
    for (const row of this.rows.values()) if (row.turn !== null) this.emit(row, true, true)
  }
}

export { resultOf }
