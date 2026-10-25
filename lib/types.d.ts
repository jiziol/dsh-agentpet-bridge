/** Deployment values; empty eventSocket resolves to the local AgentPet home. */
export interface Config {
    eventSocket: string;
}
/** Only opaque metadata travels from the desktop Client; no answers or options. */
export interface BridgeUp {
    kind: 'pending' | 'receipt';
    hostID: string;
    generation: string;
    nativeSessionID: string;
    requestID?: string;
    ok?: boolean;
    pending?: {
        id: string;
        kind: 'choice' | 'reply' | 'permission';
    } | null;
}
/** A navigation request carries the current Host and Client connection identities. */
export interface BridgeDown {
    kind: 'hello' | 'navigate' | 'resync';
    hostID: string;
    clientID: string;
    generation: string;
    profileID: string;
    requestID?: string;
    nativeSessionID?: string;
    expiresAt?: number;
    verifyOnly?: boolean;
}
