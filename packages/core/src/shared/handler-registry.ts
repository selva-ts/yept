/** Named application operations. Transports supply arguments and carry the result or error back to their caller. */
export class HandlerRegistry {
  private handlers = new Map<string, (...args: unknown[]) => unknown>();

  register<A extends unknown[], R>(channel: string, fn: (...args: A) => R | Promise<R>): void {
    if (this.handlers.has(channel)) throw new Error(`Handler already registered: ${channel}`);
    this.handlers.set(channel, (...args) => fn(...(args as A)));
  }

  channels(): string[] {
    return [...this.handlers.keys()];
  }

  async invoke(channel: string, ...args: unknown[]): Promise<unknown> {
    const handler = this.handlers.get(channel);
    if (!handler) throw new Error(`Unknown channel: ${channel}`);
    return handler(...args);
  }
}
