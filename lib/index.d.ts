import { Context } from '@deepseek-ai/cordis';
import { TypertRemoteService, type RemoteStream } from '@deepseek-ai/dsh-typert-protocol';
import z from '@deepseek-ai/schemastery';
import type { Config as BridgeConfig, BridgeUp, BridgeDown } from './types.js';
export type { BridgeUp, BridgeDown } from './types.js';
export interface Config extends BridgeConfig {
}
export declare const Config: z<Config>;
declare module '@deepseek-ai/cordis' {
    interface Context {
        agentPetBridge: AgentPetBridge;
    }
}
/** Read-only lifecycle observer with an independent, bounded navigation channel. */
export declare class AgentPetBridge extends TypertRemoteService {
    static inject: string[];
    static Config: z<Config>;
    private observer;
    private hub;
    private publisher;
    private active;
    constructor(ctx: Context, config: Config);
    private baseline;
    /** Register one authenticated Client generation and listen for navigation requests. */
    watch(clientID: string, signal: AbortSignal): RemoteStream<BridgeDown, BridgeUp>;
}
export default AgentPetBridge;
