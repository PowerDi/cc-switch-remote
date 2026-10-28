import { useCallback } from "react";
import type { ManagedAuthProvider } from "@/lib/api/auth";
import type { ManagementTarget } from "@/lib/api/remote";
import { useProvidersQuery } from "@/lib/query";
import {
  findManagedAccountUsers,
  type ManagedAccountUser,
} from "@/lib/managedAccountUsage";

/**
 * 授权中心的账号被哪些供应商在用：用前端已有的供应商列表（和供应商页同一份缓存）现算。
 */
export function useManagedAccountUsers(
  authProvider: ManagedAuthProvider,
  defaultAccountId: string | null,
  target?: ManagementTarget,
) {
  const { data: claude } = useProvidersQuery("claude", { target });
  const { data: desktop } = useProvidersQuery("claude-desktop", {
    target,
    enabled: target?.type !== "remote",
  });
  const { data: codex } = useProvidersQuery("codex", { target });
  const { data: agy } = useProvidersQuery("agy", {
    target,
    enabled: target?.type !== "remote",
  });

  return useCallback(
    (accountIds: readonly string[]): ManagedAccountUser[] =>
      findManagedAccountUsers(authProvider, accountIds, defaultAccountId, {
        claude: claude?.providers,
        "claude-desktop": desktop?.providers,
        codex: codex?.providers,
        agy: agy?.providers,
      }),
    [authProvider, defaultAccountId, claude, desktop, codex, agy],
  );
}
