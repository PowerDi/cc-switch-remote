import { createElement, type PropsWithChildren } from "react";
import { cleanup, renderHook, waitFor } from "@testing-library/react";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { afterEach, describe, expect, it, vi } from "vitest";
import { useSidebarStatus } from "@/hooks/useSidebarStatus";
import type { ManagementTarget } from "@/lib/api/remote";
const invoke = vi.hoisted(() =>
  vi.fn(async (command: string) => {
    if (command.includes("auth_get_status")) return { accounts: [] };
    if (command.includes("app_mode")) return { mode: "direct" };
    if (command.includes("usage_summary"))
      return { totalCost: "1.25", realTotalTokens: 123 };
    return { running: false };
  }),
);
vi.mock("@tauri-apps/api/core", () => ({ invoke }));
const remote: ManagementTarget = {
  type: "remote",
  profile: {
    id: "host",
    name: "Host",
    host: "192.0.2.1",
    port: 22,
    username: "user",
    authMethod: { type: "sshAgent" },
    helperPath: "/bin/helper",
    createdAt: 0,
    updatedAt: 0,
  },
  secret: { password: "fixture" },
};
afterEach(() => {
  cleanup();
  invoke.mockClear();
});
describe("sidebar background target routing", () => {
  it.each([false, true])(
    "routes every background read to selected target, remote=%s",
    async (isRemote) => {
      const client = new QueryClient({
        defaultOptions: { queries: { retry: false } },
      });
      const wrapper = ({ children }: PropsWithChildren) =>
        createElement(QueryClientProvider, { client }, children);
      const target: ManagementTarget = isRemote ? remote : { type: "local" };
      const { result } = renderHook(() => useSidebarStatus(target), {
        wrapper,
      });
      await waitFor(() => expect(result.current.todayTokens).toBe(123));
      await waitFor(() =>
        expect(
          invoke.mock.calls.filter(([command]) =>
            command.includes("auth_get_status"),
          ),
        ).toHaveLength(3),
      );
      expect(invoke.mock.calls.length).toBeGreaterThan(4);
      for (const [command, args] of invoke.mock.calls as unknown as [
        string,
        { profile?: unknown; secret?: unknown; appType?: string },
      ][]) {
        expect(command.startsWith("remote_")).toBe(isRemote);
        if (isRemote) {
          expect(args.profile).toEqual(remote.profile);
          expect(args.secret).toEqual(remote.secret);
          expect(["agy", "kimi", "mcode", "claude-desktop"]).not.toContain(
            args.appType,
          );
        }
      }
      client.clear();
    },
  );
});
