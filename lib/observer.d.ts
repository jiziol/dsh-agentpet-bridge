export declare const validID: (value: unknown) => boolean
export declare function baselineEvents(events: readonly any[]): any[]
export declare class Observer {
  constructor(profilePath: string, publish: (event: any) => unknown, now?: () => number)
  readonly profileID: string
  readonly hostID: string
  readonly hostStartedAt: number
  readonly rows: Map<string, any>
  consume(session: any, event: any, baseline?: boolean, emit?: boolean): void
  pending(nativeID: string, pending: any, baseline?: boolean): void
  emit(row: any, baseline?: boolean, heartbeat?: boolean, gap?: boolean): void
  rebaseline(gap?: boolean): void
  heartbeat(): void
  visibleText(row: any, event: any): void
  speech(row: any, event: any, item: string, text: string, mode: string): void
}
