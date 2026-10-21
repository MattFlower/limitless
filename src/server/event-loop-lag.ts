/** Timer lateness over a rolling minute, measured independently of wall-clock adjustments. */
export class EventLoopLag {
  private expected: number;
  private samples: { at: number; lag: number }[] = [];

  constructor(private readonly now: () => number = () => performance.now()) {
    this.expected = now() + 1000;
  }

  sample() {
    const at = this.now();
    this.samples = this.samples.filter((sample) => at - sample.at <= 60_000);
    const lag = Math.max(0, at - this.expected);
    this.samples.push({ at, lag });
    this.expected = at + 1000;
    return lag;
  }

  maxMs() {
    const at = this.now();
    this.samples = this.samples.filter((sample) => at - sample.at <= 60_000);
    return this.samples.reduce((max, sample) => Math.max(max, sample.lag), 0);
  }
}
