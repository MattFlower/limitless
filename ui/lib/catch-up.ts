export type Timers = { set: typeof setTimeout; clear: typeof clearTimeout };

// A live stream replays nothing that changed while it was down, so the store re-fetches its REST
// snapshot when the stream reopens after a gap. Whatever the stream pushes after a fetch starts
// is at least as new as that snapshot, so `apply` receives those keys and must keep the pushed
// versions. Reconnects are debounced and coalesced: one fetch at a time, and one more afterwards
// if the stream dropped again while it ran.
export function createCatchUp<T>(
  fetch: () => Promise<T>,
  apply: (snapshot: T, pushed: ReadonlySet<string>) => void,
  fail: (error: unknown) => void,
  timers: Timers = { set: setTimeout, clear: clearTimeout },
  debounceMs = 250,
) {
  const pushed = new Set<string>();
  let loading = false;
  let again = false;
  let loaded = false;
  let wasOpen = false;
  let missedUpdates = false;
  let timer: ReturnType<typeof setTimeout> | undefined;
  const schedule = () => {
    timers.clear(timer);
    timer = timers.set(load, debounceMs);
  };
  const load = () => {
    if (loading) {
      again = true;
      return;
    }
    loading = true;
    pushed.clear();
    fetch()
      .then(
        (snapshot) => {
          loaded = true;
          apply(snapshot, pushed);
        },
        (error) => fail(error),
      )
      .finally(() => {
        loading = false;
        if (again) {
          again = false;
          schedule();
        }
      });
  };
  return {
    load,
    pushed: (key: string) => void pushed.add(key),
    connected(isConnected: boolean) {
      // Only a drop after the stream was open is a gap; the first load covers the time before.
      if (!isConnected) missedUpdates ||= wasOpen;
      else {
        wasOpen = true;
        if (missedUpdates || (!loaded && !loading)) schedule();
        missedUpdates = false;
      }
    },
  };
}
