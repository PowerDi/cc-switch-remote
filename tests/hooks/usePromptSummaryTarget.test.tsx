import type { ReactNode } from "react";
import { act, cleanup, renderHook, waitFor } from "@testing-library/react";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import {
  enabledPromptOf,
  promptKeys,
  usePromptListQuery,
} from "@/lib/query/prompts";
import type { ManagementTarget } from "@/lib/api/remote";
import type { Prompt } from "@/lib/api/prompts";

const invoke = vi.hoisted(() => vi.fn());
vi.mock("@tauri-apps/api/core", () => ({
  invoke: (...args: unknown[]) => invoke(...args),
}));
const remote: ManagementTarget = {
  type: "remote",
  profile: {
    id: "server",
    name: "server",
    host: "192.0.2.10",
    port: 22,
    username: "tester",
    authMethod: { type: "sshAgent" },
    helperPath: "/bin/helper",
    createdAt: 1,
    updatedAt: 1,
  },
  secret: { password: "test-secret" },
};
const data = (name: string): Record<string, Prompt> => ({
  p: { id: "p", name, content: name, enabled: true },
});
const clients: QueryClient[] = [];
function setup() {
  const client = new QueryClient({
    defaultOptions: { queries: { retry: false } },
  });
  clients.push(client);
  const wrapper = ({ children }: { children: ReactNode }) => (
    <QueryClientProvider client={client}>{children}</QueryClientProvider>
  );
  return { client, wrapper };
}
beforeEach(() => invoke.mockReset());
afterEach(() => {
  cleanup();
  clients.splice(0).forEach((client) => client.clear());
});

describe("shared prompt summary query", () => {
  it("preserves the local command, cache key and enabled prompt", async () => {
    invoke.mockResolvedValueOnce(data("local"));
    const { client, wrapper } = setup();
    const { result } = renderHook(() => usePromptListQuery("codex"), {
      wrapper,
    });
    await waitFor(() =>
      expect(enabledPromptOf(result.current.data)?.name).toBe("local"),
    );
    expect(invoke.mock.calls).toEqual([["get_prompts", { app: "codex" }]]);
    expect(client.getQueryData(promptKeys.list("codex"))).toEqual(
      data("local"),
    );
  });
  it("uses the selected remote profile/secret without touching the local command", async () => {
    invoke.mockResolvedValueOnce(data("remote"));
    const { wrapper, client } = setup();
    const { result } = renderHook(
      () => usePromptListQuery("codex", true, remote),
      { wrapper },
    );
    await waitFor(() => expect(result.current.data?.p.name).toBe("remote"));
    expect(invoke.mock.calls).toEqual([
      [
        "remote_get_prompts",
        { profile: remote.profile, app: "codex", secret: remote.secret },
      ],
    ]);
    const keys = client
      .getQueryCache()
      .getAll()
      .map((query) => query.queryKey);
    expect(keys[0].slice(0, 4)).toEqual([
      "prompts",
      "list",
      "codex",
      "remote:server",
    ]);
    expect(JSON.stringify(keys)).not.toContain("test-secret");
    expect(client.getQueryData(promptKeys.list("codex"))).toBeUndefined();
  });
  it("discards the old list when the connection changes in place", async () => {
    const target = structuredClone(remote);
    invoke.mockResolvedValueOnce(data("old"));
    const { wrapper, client } = setup();
    const { result, rerender } = renderHook(
      ({ target }: { target: ManagementTarget }) =>
        usePromptListQuery("claude", true, target),
      { wrapper, initialProps: { target: target as ManagementTarget } },
    );
    await waitFor(() => expect(result.current.data?.p.name).toBe("old"));
    let finish!: (value: Record<string, Prompt>) => void;
    invoke.mockReturnValueOnce(
      new Promise<Record<string, Prompt>>((resolve) => {
        finish = resolve;
      }),
    );
    target.profile.host = "192.0.2.11";
    rerender({ target });
    expect(result.current.data).toBeUndefined();
    await act(async () => finish(data("new")));
    await waitFor(() => expect(result.current.data?.p.name).toBe("new"));
    expect(client.getQueryCache().getAll()).toHaveLength(2);
  });
  it("does not read unsupported apps or disabled summaries", async () => {
    const { wrapper } = setup();
    renderHook(
      () => ({
        absent: usePromptListQuery(null, true, remote),
        disabled: usePromptListQuery("codex", false, remote),
      }),
      { wrapper },
    );
    await act(async () => {});
    expect(invoke).not.toHaveBeenCalled();
  });
});
