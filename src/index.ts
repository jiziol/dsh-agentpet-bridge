import { Context } from '@deepseek-ai/cordis'
import { Remote, TypertRemoteService, type RemoteStream } from '@deepseek-ai/dsh-typert-protocol'
import z from '@deepseek-ai/schemastery'
import os from 'node:os'
import path from 'node:path'
import { Observer, validID, baselineEvents } from '../lib/observer.js'
import { Mailbox, NavigationHub, Publisher } from '../lib/transport.js'

import type { Config as BridgeConfig, BridgeUp, BridgeDown } from './types.js'
export type { BridgeUp, BridgeDown } from './types.js'
export interface Config extends BridgeConfig {}
export const Config: z<Config> = z.object({ eventSocket: z.string().default('') })

declare module '@deepseek-ai/cordis' {
  interface Context { agentPetBridge: AgentPetBridge }
}

/** Read-only lifecycle observer with an independent, bounded navigation channel. */
export class AgentPetBridge extends TypertRemoteService {
  static inject: string[] = ['agents', 'sessions', 'typert']
  static Config: z<Config> = Config
  private observer: any
  private hub: any
  private publisher: any
  private active: boolean = true

  constructor(ctx: Context, config: Config) {
    super(ctx, 'agentPetBridge')
    const eventSocket = config.eventSocket || path.join(process.env.AGENTPET_LOCAL_HOME || path.join(os.homedir(), '.agentpet-local'), 'agentpet.sock')
    if (!path.isAbsolute(eventSocket) || Buffer.byteLength(eventSocket) >= 104) throw new Error('invalid AgentPet eventSocket')
    const runtime = ctx as any
    // Identity names the DSH profile, not the caller's working directory: ACP
    // hosts start in the session workspace while the Desktop host starts in the
    // profile directory. `profileContext.dir` is the host-owned profile path on
    // every surface; cwd stays the fallback for hosts that provide no context.
    const profileContext = runtime.get?.('profileContext') as { dir?: unknown } | undefined
    const profilePath = typeof profileContext?.dir === 'string' && profileContext.dir.length > 0
      ? profileContext.dir
      : process.cwd()
    this.observer = new Observer(profilePath, (event: unknown) => this.publisher.send(event))
    this.publisher = new Publisher(eventSocket, (gap: boolean) => this.observer.rebaseline(gap))
    this.hub = new NavigationHub(this.observer, () => ({ eventConnected: this.publisher.connected === true, eventSocket }))
    const started = this.hub.listen()
    started.then(() => { if (this.active) this.observer.rebaseline() }).catch(() => {})
    started.catch(() => { if (this.active) ctx.logger.warn('AgentPet navigation endpoint unavailable') })
    // Baselines never manufacture completion notifications for old history.
    for (const agent of runtime.agents.list()) this.baseline(agent.session)
    ctx.on('session/event' as any, (session: any, event: any) => {
      try { this.observer.consume(session, event) }
      catch { ctx.logger.warn('AgentPet observation rejected') }
    })
    ctx.on('agent/created' as any, ({ agent }: any) => this.baseline(agent.session))
    ctx.on('agent/disposed' as any, ({ agent }: any) => {
      const row = this.observer.rows.get(agent.id)
      if (row?.phase === 'working' && !row.result) {
        row.phase = 'done'; row.result = 'unknown'; row.pending = []
        row.endedAt = Date.now() / 1000; row.message = '会话连接已中断，任务结果未知'
        this.observer.emit(row)
      }
    })
    const heartbeat = setInterval(() => this.observer.heartbeat(), 15000); heartbeat.unref()
    ctx.effect(() => async () => {
      this.active = false; clearInterval(heartbeat); this.publisher.close()
      await started.catch(() => {}); await this.hub.close()
    }, 'agentpet bridge lifetime')
  }

  private baseline(session: any): void {
    // The attached Session already owns this history; no disk scan or activation.
    for (const event of baselineEvents(session.snapshotEvents())) this.observer.consume(session, event, true, false)
    const row = this.observer.rows.get(session.id)
    if (row?.turn !== null && row?.turn !== undefined) this.observer.emit(row, true)
  }

  /** Register one authenticated Client generation and listen for navigation requests. */
  @Remote({ mode: 'stream' })
  async *watch(clientID: string, signal: AbortSignal): RemoteStream<BridgeDown, BridgeUp> {
    if (!validID(clientID) || !this.active) throw new Error('invalid Client')
    const mailbox = new Mailbox()
    const release = this.hub.register(clientID, (frame: BridgeDown) => mailbox.push(frame), () => mailbox.close())
    const client = this.hub.clients.get(clientID)!
    mailbox.push({ kind: 'hello', hostID: this.observer.hostID, profileID: this.observer.profileID,
      clientID, generation: client.generation })
    const uplink = this.ctx.invocation!.uplink<BridgeUp>()
    const consume = (async () => {
      for await (const frame of uplink) {
        if (Buffer.byteLength(JSON.stringify(frame)) > 8192) throw new Error('oversized uplink')
        if (frame.hostID !== this.observer.hostID || frame.generation !== client.generation) continue
        if (frame.kind === 'receipt') this.hub.acknowledge(clientID, frame)
        else if (frame.kind === 'pending' && this.hub.clients.size === 1 && validID(frame.nativeSessionID) && frame.pending !== undefined) {
          if (frame.pending !== null && (!validID(frame.pending.id) || !['choice', 'reply', 'permission'].includes(frame.pending.kind))) continue
          this.observer.pending(frame.nativeSessionID, frame.pending)
        }
      }
    })().catch(() => { if (this.active && !signal.aborted) this.ctx.logger.warn('AgentPet Client stream ended') })
      .finally(() => mailbox.close())
    try { yield* mailbox.iterate(signal) }
    finally { release(); mailbox.close(); void consume }
  }
}

export default AgentPetBridge
