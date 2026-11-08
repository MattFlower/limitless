const requests = new WeakMap<AbortSignal, Set<Promise<unknown>>>();

export function trackClaimWork(signal: AbortSignal | undefined, request: Promise<unknown>): void {
  if (!signal) return;
  const pending = requests.get(signal) ?? new Set<Promise<unknown>>();
  requests.set(signal, pending);
  pending.add(request);
  const done = () => {
    pending.delete(request);
  };
  void request.then(done, done);
}

/** Cancellation ends a caller's wait; shutdown also drains its underlying transports. */
export async function drainClaimWork(signal: AbortSignal): Promise<void> {
  const pending = requests.get(signal);
  while (pending?.size) await Promise.allSettled([...pending]);
}
