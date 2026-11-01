type Activity = { count: number; total: number; max: number; active: number; starts: number };

/** Bounded aggregates retain completed work as well as sections still awaiting I/O. */
export class StallReporter {
  private readonly entries = new Map<string, Activity>();
  constructor(
    readonly now: () => number = () => performance.now(),
    private readonly log: (line: string) => void = (line) => console.warn(line),
  ) {}

  private entry(name: string) {
    let entry = this.entries.get(name);
    if (!entry && this.entries.size < 64) {
      entry = { count: 0, total: 0, max: 0, active: 0, starts: 0 };
      this.entries.set(name, entry);
    }
    return entry;
  }

  private record(entry: Activity | undefined, duration: number) {
    if (!entry) return;
    entry.count++;
    entry.total += duration;
    entry.max = Math.max(entry.max, duration);
  }

  activity<T>(name: string, fn: () => T, minMs?: number): T {
    const entry = minMs === undefined ? this.entry(name) : undefined,
      start = this.now();
    try {
      return fn();
    } finally {
      const duration = this.now() - start;
      if (minMs === undefined || duration > minMs) this.record(entry ?? this.entry(name), duration);
    }
  }

  beginActivity(name: string): () => void {
    const entry = this.entry(name),
      start = this.now();
    if (entry) {
      entry.active++;
      entry.starts += start;
    }
    let ended = false;
    return () => {
      if (ended) return;
      ended = true;
      if (entry) {
        entry.active--;
        entry.starts -= start;
      }
      this.record(entry, this.now() - start);
    };
  }

  sample(lagMs: number) {
    const at = this.now();
    if (lagMs >= 2000) {
      const elapsed = (e: Activity) => e.active * at - e.starts;
      const names = [...this.entries]
        .filter(([, e]) => e.count || e.active)
        .sort(([, a], [, b]) => b.total + elapsed(b) - a.total - elapsed(a))
        .slice(0, 5)
        .map(
          ([name, e]) =>
            `${name}: count=${e.count} total=${Math.round(e.total)}ms max=${Math.round(e.max)}ms${e.active ? ` active=${e.active} elapsed=${Math.round(elapsed(e))}ms` : ""}`,
        );
      this.log(`Event loop stall: lag=${Math.round(lagMs)}ms; ${names.join("; ")}`);
    }
    for (const [name, entry] of this.entries) {
      if (entry.active) entry.count = entry.total = entry.max = 0;
      else this.entries.delete(name);
    }
  }
}

export const stallReporter = new StallReporter();
export const activity = <T>(name: string, fn: () => T): T => stallReporter.activity(name, fn);
export const beginActivity = (name: string) => stallReporter.beginActivity(name);
