var __runInitializers = (this && this.__runInitializers) || function (thisArg, initializers, value) {
    var useValue = arguments.length > 2;
    for (var i = 0; i < initializers.length; i++) {
        value = useValue ? initializers[i].call(thisArg, value) : initializers[i].call(thisArg);
    }
    return useValue ? value : void 0;
};
var __esDecorate = (this && this.__esDecorate) || function (ctor, descriptorIn, decorators, contextIn, initializers, extraInitializers) {
    function accept(f) { if (f !== void 0 && typeof f !== "function") throw new TypeError("Function expected"); return f; }
    var kind = contextIn.kind, key = kind === "getter" ? "get" : kind === "setter" ? "set" : "value";
    var target = !descriptorIn && ctor ? contextIn["static"] ? ctor : ctor.prototype : null;
    var descriptor = descriptorIn || (target ? Object.getOwnPropertyDescriptor(target, contextIn.name) : {});
    var _, done = false;
    for (var i = decorators.length - 1; i >= 0; i--) {
        var context = {};
        for (var p in contextIn) context[p] = p === "access" ? {} : contextIn[p];
        for (var p in contextIn.access) context.access[p] = contextIn.access[p];
        context.addInitializer = function (f) { if (done) throw new TypeError("Cannot add initializers after decoration has completed"); extraInitializers.push(accept(f || null)); };
        var result = (0, decorators[i])(kind === "accessor" ? { get: descriptor.get, set: descriptor.set } : descriptor[key], context);
        if (kind === "accessor") {
            if (result === void 0) continue;
            if (result === null || typeof result !== "object") throw new TypeError("Object expected");
            if (_ = accept(result.get)) descriptor.get = _;
            if (_ = accept(result.set)) descriptor.set = _;
            if (_ = accept(result.init)) initializers.unshift(_);
        }
        else if (_ = accept(result)) {
            if (kind === "field") initializers.unshift(_);
            else descriptor[key] = _;
        }
    }
    if (target) Object.defineProperty(target, contextIn.name, descriptor);
    done = true;
};
import { Remote, TypertRemoteService } from '@deepseek-ai/dsh-typert-protocol';
import z from '@deepseek-ai/schemastery';
import os from 'node:os';
import path from 'node:path';
import { Observer, validID, baselineEvents } from '../lib/observer.js';
import { Mailbox, NavigationHub, Publisher } from '../lib/transport.js';
export const Config = z.object({ eventSocket: z.string().default('') });
/** Read-only lifecycle observer with an independent, bounded navigation channel. */
let AgentPetBridge = (() => {
    let _classSuper = TypertRemoteService;
    let _instanceExtraInitializers = [];
    let _watch_decorators;
    return class AgentPetBridge extends _classSuper {
        static {
            const _metadata = typeof Symbol === "function" && Symbol.metadata ? Object.create(_classSuper[Symbol.metadata] ?? null) : void 0;
            _watch_decorators = [Remote({ mode: 'stream' })];
            __esDecorate(this, null, _watch_decorators, { kind: "method", name: "watch", static: false, private: false, access: { has: obj => "watch" in obj, get: obj => obj.watch }, metadata: _metadata }, null, _instanceExtraInitializers);
            if (_metadata) Object.defineProperty(this, Symbol.metadata, { enumerable: true, configurable: true, writable: true, value: _metadata });
        }
        static inject = ['agents', 'sessions', 'typert'];
        static Config = Config;
        observer = __runInitializers(this, _instanceExtraInitializers);
        hub;
        publisher;
        active = true;
        constructor(ctx, config) {
            super(ctx, 'agentPetBridge');
            const eventSocket = config.eventSocket || path.join(process.env.AGENTPET_LOCAL_HOME || path.join(os.homedir(), '.agentpet-local'), 'agentpet.sock');
            if (!path.isAbsolute(eventSocket) || Buffer.byteLength(eventSocket) >= 104)
                throw new Error('invalid AgentPet eventSocket');
            const runtime = ctx;
            // Identity names the DSH profile, not the caller's working directory: ACP
            // hosts start in the session workspace while the Desktop host starts in the
            // profile directory. `profileContext.dir` is the host-owned profile path on
            // every surface; cwd stays the fallback for hosts that provide no context.
            const profileContext = runtime.get?.('profileContext');
            const profilePath = typeof profileContext?.dir === 'string' && profileContext.dir.length > 0
                ? profileContext.dir
                : process.cwd();
            this.observer = new Observer(profilePath, (event) => this.publisher.send(event));
            this.publisher = new Publisher(eventSocket, (gap) => this.observer.rebaseline(gap));
            this.hub = new NavigationHub(this.observer, () => ({ eventConnected: this.publisher.connected === true, eventSocket }));
            const started = this.hub.listen();
            started.then(() => { if (this.active)
                this.observer.rebaseline(); }).catch(() => { });
            started.catch(() => { if (this.active)
                ctx.logger.warn('AgentPet navigation endpoint unavailable'); });
            // Baselines never manufacture completion notifications for old history.
            for (const agent of runtime.agents.list())
                this.baseline(agent.session);
            ctx.on('session/event', (session, event) => {
                try {
                    this.observer.consume(session, event);
                }
                catch {
                    ctx.logger.warn('AgentPet observation rejected');
                }
            });
            ctx.on('agent/created', ({ agent }) => this.baseline(agent.session));
            ctx.on('agent/disposed', ({ agent }) => {
                const row = this.observer.rows.get(agent.id);
                if (row?.phase === 'working' && !row.result) {
                    row.phase = 'done';
                    row.result = 'unknown';
                    row.pending = [];
                    row.endedAt = Date.now() / 1000;
                    row.message = '会话连接已中断，任务结果未知';
                    this.observer.emit(row);
                }
            });
            const heartbeat = setInterval(() => this.observer.heartbeat(), 15000);
            heartbeat.unref();
            ctx.effect(() => async () => {
                this.active = false;
                clearInterval(heartbeat);
                this.publisher.close();
                await started.catch(() => { });
                await this.hub.close();
            }, 'agentpet bridge lifetime');
        }
        baseline(session) {
            // The attached Session already owns this history; no disk scan or activation.
            for (const event of baselineEvents(session.snapshotEvents()))
                this.observer.consume(session, event, true, false);
            const row = this.observer.rows.get(session.id);
            if (row?.turn !== null && row?.turn !== undefined)
                this.observer.emit(row, true);
        }
        /** Register one authenticated Client generation and listen for navigation requests. */
        async *watch(clientID, signal) {
            if (!validID(clientID) || !this.active)
                throw new Error('invalid Client');
            const mailbox = new Mailbox();
            const release = this.hub.register(clientID, (frame) => mailbox.push(frame), () => mailbox.close());
            const client = this.hub.clients.get(clientID);
            mailbox.push({ kind: 'hello', hostID: this.observer.hostID, profileID: this.observer.profileID,
                clientID, generation: client.generation });
            const uplink = this.ctx.invocation.uplink();
            const consume = (async () => {
                for await (const frame of uplink) {
                    if (Buffer.byteLength(JSON.stringify(frame)) > 8192)
                        throw new Error('oversized uplink');
                    if (frame.hostID !== this.observer.hostID || frame.generation !== client.generation)
                        continue;
                    if (frame.kind === 'receipt')
                        this.hub.acknowledge(clientID, frame);
                    else if (frame.kind === 'pending' && this.hub.clients.size === 1 && validID(frame.nativeSessionID) && frame.pending !== undefined) {
                        if (frame.pending !== null && (!validID(frame.pending.id) || !['choice', 'reply', 'permission'].includes(frame.pending.kind)))
                            continue;
                        this.observer.pending(frame.nativeSessionID, frame.pending);
                    }
                }
            })().catch(() => { if (this.active && !signal.aborted)
                this.ctx.logger.warn('AgentPet Client stream ended'); })
                .finally(() => mailbox.close());
            try {
                yield* mailbox.iterate(signal);
            }
            finally {
                release();
                mailbox.close();
                void consume;
            }
        }
    };
})();
export { AgentPetBridge };
export default AgentPetBridge;
