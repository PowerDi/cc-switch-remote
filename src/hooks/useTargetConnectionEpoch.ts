import {
  useQueryClient,
  type QueryClient,
  type QueryKey,
} from "@tanstack/react-query";
import type { ManagementTarget } from "@/lib/api/remote";
import { hasSameConnectionIdentity } from "./useTargetQueryIdentityReset";

// Shared across observers and remounts. Only an opaque epoch enters cache keys;
// profile credentials remain in memory, never serialized as query identity.
const connections = new WeakMap<
  QueryClient,
  Map<string, { target: ManagementTarget; epoch: number }>
>();
let nextEpoch = 0;

export function useTargetConnectionEpoch(
  target: ManagementTarget,
): number | undefined {
  const client = useQueryClient();
  if (target.type === "local") return undefined;
  let hosts = connections.get(client);
  if (!hosts) {
    hosts = new Map();
    connections.set(client, hosts);
  }
  let entry = hosts.get(target.profile.id);
  if (!entry || !hasSameConnectionIdentity(entry.target, target)) {
    entry = { target: structuredClone(target), epoch: ++nextEpoch };
    hosts.set(target.profile.id, entry);
  }
  return entry.epoch;
}

export function isCurrentTargetConnection(
  client: QueryClient,
  target: ManagementTarget,
  epoch: number | undefined,
): boolean {
  if (target.type === "local") return true;
  const entry = connections.get(client)?.get(target.profile.id);
  return (
    entry?.epoch === epoch &&
    entry !== undefined &&
    hasSameConnectionIdentity(entry.target, target)
  );
}

export function withConnectionEpoch(
  key: QueryKey,
  epoch: number | undefined,
): QueryKey {
  return epoch === undefined ? key : [...key, "connection", epoch];
}
