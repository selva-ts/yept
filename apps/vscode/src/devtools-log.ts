import type { HostEvents } from '@yept/core/shared/ipc';

/** A send that Dev Tools shows: a request panel's, or a collection run's step. */
export type DevToolsEvent =
  | { channel: 'devtools:run'; payload: HostEvents['devtools:run'] }
  | { channel: 'runner:event'; payload: HostEvents['runner:event'] };

/** Network rows Dev Tools keeps, as on the desktop. */
export const MAX_RUNS = 500;

const starts = (e: DevToolsEvent): boolean => (e.channel === 'devtools:run' ? e.payload.type === 'start' : e.payload.type === 'step-start');

/**
 * This session's sends, in order, so the Dev Tools view shows them whenever it is opened, like the desktop's drawer,
 * which records them from the start. Kept in memory only, for the last MAX_RUNS sends; Clear in the view forgets them.
 */
export class DevToolsLog {
  private events: DevToolsEvent[] = [];
  private runs = 0;

  add(event: DevToolsEvent): void {
    this.events.push(event);
    if (!starts(event)) return;
    this.runs++;
    // Drop the oldest send with everything after it up to the next send.
    while (this.runs > MAX_RUNS) {
      this.events.shift();
      while (this.events.length && !starts(this.events[0])) this.events.shift();
      this.runs--;
    }
  }

  all(): readonly DevToolsEvent[] {
    return this.events;
  }

  clear(): void {
    this.events = [];
    this.runs = 0;
  }
}
