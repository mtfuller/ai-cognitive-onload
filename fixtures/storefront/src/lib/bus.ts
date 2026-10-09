export interface Bus {
  publish(topic: string, payload: string): Promise<void>
  subscribe(topic: string, handler: (msg: { topic: string; payload: string }) => Promise<void>): void
}
