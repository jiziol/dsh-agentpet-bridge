export declare class Publisher {
  constructor(socketPath: string, onConnect: (gap: boolean) => void)
  send(event: any): boolean
  close(): void
}
export declare class NavigationHub {
  constructor(observer: any, health?: () => { eventConnected: boolean; eventSocket: string })
  readonly clients: Map<string, any>
  register(clientID: string, push: (frame: any) => boolean, close?: () => void): () => void
  acknowledge(clientID: string, ack: any): boolean
  listen(): Promise<void>
  close(): Promise<void>
}
export declare class Mailbox {
  push(frame: any): boolean
  close(): void
  iterate(signal: AbortSignal): AsyncIterable<any>
}
