/** Explicit cookie-value reveals are available for recent sends only, in memory, never from the current jar. */
export class RecentCookies {
  private values = new Map<string, string[]>();
  constructor(private limit = 50) {}

  keep(runId: string, values: string[]): void {
    this.values.delete(runId);
    this.values.set(runId, [...values]);
    while (this.values.size > this.limit) this.values.delete(this.values.keys().next().value!);
  }

  reveal(runId: string, index: number): string {
    const values = this.values.get(runId);
    if (!values) throw new Error('Cookie values are only kept for the last 50 sends in this session. History keeps metadata only.');
    if (!Number.isInteger(index) || index < 0 || index >= values.length) throw new Error('This cookie was not recorded for that run.');
    return values[index];
  }

  clear(): void { this.values.clear(); }
}
