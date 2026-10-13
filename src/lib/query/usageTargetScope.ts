import type { QueryKey } from "@tanstack/react-query";
import type { ManagementTarget } from "@/lib/api/remote";
import {
  useTargetConnectionEpoch,
  withConnectionEpoch,
} from "@/hooks/useTargetConnectionEpoch";

export function useUsageTargetScope(target: ManagementTarget) {
  const epoch = useTargetConnectionEpoch(target);
  const prefix =
    target.type === "remote"
      ? ["usage", "remote", target.profile.id]
      : ["usage", "local"];

  return {
    key: (key: QueryKey): QueryKey => withConnectionEpoch(key, epoch),
    // Preserve v4's smooth filter/pagination updates, never another machine's
    // data or the previous credentials' cached response, even for one frame.
    placeholderData: <T>(
      data: T | undefined,
      previous?: { queryKey: QueryKey },
    ) => {
      const key = previous?.queryKey;
      if (!key || !prefix.every((part, index) => key[index] === part))
        return undefined;
      if (
        epoch !== undefined &&
        (key[key.length - 2] !== "connection" || key[key.length - 1] !== epoch)
      ) {
        return undefined;
      }
      return data;
    },
  };
}
