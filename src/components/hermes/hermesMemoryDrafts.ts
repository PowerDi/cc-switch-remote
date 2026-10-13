import { useSyncExternalStore } from "react";
import { useQueryClient, type QueryClient } from "@tanstack/react-query";
import type { HermesMemoryKind } from "@/types";
import type { ManagementTarget } from "@/lib/api/remote";
import { LOCAL_MANAGEMENT_TARGET } from "@/lib/managementTarget";
import { useTargetConnectionEpoch } from "@/hooks/useTargetConnectionEpoch";

/** Header and editor share a draft, but never share it across connections.
 * Drafts stay in memory only. Leaving the page clears both files. */
export interface HermesMemoryDraftState {
  active: HermesMemoryKind;
  draft: Partial<Record<HermesMemoryKind, string>>;
  saved: Partial<Record<HermesMemoryKind, string>>;
  generation: number;
}

const initialState = (generation = 0): HermesMemoryDraftState => ({
  active: "memory",
  draft: {},
  saved: {},
  generation,
});

export function createHermesMemoryDraftStore() {
  let state = initialState();
  const listeners = new Set<() => void>();
  const update = (next: Partial<HermesMemoryDraftState>) => {
    state = { ...state, ...next };
    listeners.forEach((listener) => listener());
  };
  return {
    getState: () => state,
    subscribe(listener: () => void) {
      listeners.add(listener);
      return () => {
        listeners.delete(listener);
      };
    },
    setActive(kind: HermesMemoryKind) {
      if (state.active !== kind) update({ active: kind });
    },
    /** Refetches must not overwrite edits made since the initial load. */
    hydrate(kind: HermesMemoryKind, content: string) {
      if (state.saved[kind] !== undefined) return;
      update({
        draft: { ...state.draft, [kind]: content },
        saved: { ...state.saved, [kind]: content },
      });
    },
    edit(kind: HermesMemoryKind, content: string) {
      update({ draft: { ...state.draft, [kind]: content } });
    },
    /** A completion after reset cannot mark a newly opened draft as saved. */
    markSaved(
      kind: HermesMemoryKind,
      content: string,
      generation = state.generation,
    ) {
      if (generation !== state.generation) return;
      update({ saved: { ...state.saved, [kind]: content } });
    },
    reset() {
      update(initialState(state.generation + 1));
    },
  };
}

// Keep the upstream local interface; remote stores have opaque connection keys,
// not credentials, and share the QueryClient's lifetime.
export const hermesMemoryDrafts = createHermesMemoryDraftStore();
type DraftStore = ReturnType<typeof createHermesMemoryDraftStore>;
const remoteDrafts = new WeakMap<QueryClient, Map<number, DraftStore>>();

export function useHermesMemoryDraftStore(
  target: ManagementTarget = LOCAL_MANAGEMENT_TARGET,
): DraftStore {
  const client = useQueryClient();
  const epoch = useTargetConnectionEpoch(target);
  if (epoch === undefined) return hermesMemoryDrafts;
  let stores = remoteDrafts.get(client);
  if (!stores) {
    stores = new Map();
    remoteDrafts.set(client, stores);
  }
  let store = stores.get(epoch);
  if (!store) {
    store = createHermesMemoryDraftStore();
    stores.set(epoch, store);
  }
  return store;
}

export function isHermesMemoryDirty(
  current: HermesMemoryDraftState,
  kind: HermesMemoryKind,
) {
  const draft = current.draft[kind];
  return draft !== undefined && draft !== current.saved[kind];
}

export function useHermesMemoryDrafts(store: DraftStore = hermesMemoryDrafts) {
  return useSyncExternalStore(store.subscribe, store.getState, store.getState);
}
