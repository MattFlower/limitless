// A live stream replays nothing that changed while it was down, so a page re-fetches its REST
// snapshot when the stream reopens after a gap. Whatever the stream pushes after a fetch starts
// is at least as new as that snapshot, so `apply` receives those keys and must keep the pushed
// versions; a fetch overtaken by a newer one is dropped.
export function createCatchUp<T>(
  fetch: () => Promise<T>,
  apply: (snapshot: T, pushed: ReadonlySet<string>) => void,
  fail: (error: unknown) => void = () => {},
) {
  const pushed = new Set<string>();
  let generation = 0;
  let missedUpdates = false;
  const load = () => {
    const current = ++generation;
    pushed.clear();
    fetch().then(
      (snapshot) => {
        if (current === generation) apply(snapshot, pushed);
      },
      (error) => {
        if (current === generation) fail(error);
      },
    );
  };
  return {
    load,
    pushed: (key: string) => void pushed.add(key),
    connected(isConnected: boolean) {
      if (!isConnected) missedUpdates = true;
      else if (missedUpdates) {
        missedUpdates = false;
        load();
      }
    },
  };
}
