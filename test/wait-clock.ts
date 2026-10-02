/** Explicit clock and timers: provider waits advance without sleeping or changing global time. */
export function waitClock() {
  let now = Date.now();
  let sequence = 0;
  const pending = new Map<number, { at: number; callback: () => void }>();
  return {
    now: () => now,
    timer: {
      set: ((callback: () => void, ms: number) => {
        const id = ++sequence;
        pending.set(id, { at: now + ms, callback });
        return id as unknown as ReturnType<typeof setInterval>;
      }) as typeof setInterval,
      clear: ((id: ReturnType<typeof setInterval>) => {
        pending.delete(id as unknown as number);
      }) as typeof clearInterval,
    },
    get pending() {
      return pending.size;
    },
    async advance(ms: number) {
      now += ms;
      for (const [id, entry] of [...pending]) {
        if (entry.at <= now) {
          pending.delete(id);
          entry.callback();
        }
      }
      await this.flush();
    },
    async flush() {
      for (let i = 0; i < 30; i++) await Promise.resolve();
    },
  };
}
