const requests = new WeakMap<object, Set<Promise<unknown>>>();

export function trackClaimWork(owner: object | undefined, request: Promise<unknown>): void {
  if (!owner) return;
  const pending = requests.get(owner) ?? new Set<Promise<unknown>>();
  requests.set(owner, pending);
  pending.add(request);
  const done = () => {
    pending.delete(request);
  };
  void request.then(done, done);
}

/** Cancellation ends a caller's wait; shutdown also drains its underlying transports. */
export async function drainClaimWork(owner: object): Promise<void> {
  const pending = requests.get(owner);
  while (pending?.size) await Promise.allSettled([...pending]);
}
