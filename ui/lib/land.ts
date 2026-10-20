import type { LandEntry } from "../../src/core/types.ts";

export type LandListState = { entries: LandEntry[]; error: string; cancelling: number[] };
export function newestLand(entries: readonly LandEntry[]): LandEntry[] {
  return [...entries].sort((a, b) => b.createdAt - a.createdAt || b.id - a.id);
}

export function createLandController(
  api: { list: () => Promise<LandEntry[]>; cancel: (id: number) => Promise<unknown> },
  changed: (state: LandListState) => void,
) {
  let generation = 0;
  let disposed = false;
  let state: LandListState = { entries: [], error: "", cancelling: [] };
  const update = (patch: Partial<LandListState>) => {
    state = { ...state, ...patch };
    if (!disposed) changed(state);
  };
  const load = async () => {
    const request = ++generation;
    try {
      const entries = await api.list();
      if (!disposed && request === generation) update({ entries: newestLand(entries), error: "" });
    } catch (error) {
      if (!disposed && request === generation) update({ error: String(error) });
    }
  };
  return {
    load,
    async cancel(id: number) {
      if (state.cancelling.includes(id)) return;
      update({ cancelling: [...state.cancelling, id] });
      let failure = "";
      try {
        await api.cancel(id);
      } catch (error) {
        failure = String(error);
      } finally {
        await load();
        update({
          cancelling: state.cancelling.filter((value) => value !== id),
          ...(failure ? { error: failure } : {}),
        });
      }
    },
    dispose() {
      disposed = true;
      generation++;
    },
  };
}
