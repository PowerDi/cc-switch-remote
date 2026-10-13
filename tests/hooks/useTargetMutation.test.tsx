import { act, cleanup, renderHook, waitFor } from "@testing-library/react";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import type { ReactNode } from "react";
import { afterEach, describe, expect, it, vi } from "vitest";
import { useTargetMutation } from "@/hooks/useTargetMutation";
import type { ManagementTarget } from "@/lib/api/remote";

const local: ManagementTarget = { type: "local" };
const remote: ManagementTarget = {
  type: "remote",
  profile: {
    id: "a",
    name: "A",
    host: "192.0.2.5",
    port: 22,
    username: "tester",
    authMethod: { type: "sshAgent" },
    helperPath: "/bin/helper",
    createdAt: 0,
    updatedAt: 0,
  },
  secret: { password: "test-secret" },
};
const clients: QueryClient[] = [];
function setup() {
  // A non-idempotent mutation must not inherit a future global retry policy.
  const client = new QueryClient({
    defaultOptions: { mutations: { retry: 2, retryDelay: 0 } },
  });
  clients.push(client);
  const wrapper = ({ children }: { children: ReactNode }) => (
    <QueryClientProvider client={client}>{children}</QueryClientProvider>
  );
  return { wrapper };
}
afterEach(() => {
  cleanup();
  clients.splice(0).forEach((client) => client.clear());
});

describe("useTargetMutation submission binding", () => {
  it("freezes target and execution handler before the first async boundary", async () => {
    const run = vi.fn().mockResolvedValue("saved");
    const complete = vi.fn();
    const { wrapper } = setup();
    const original = structuredClone(remote);
    const mutable = structuredClone(remote);
    const { result, rerender } = renderHook(
      ({ target, label }: { target: ManagementTarget; label: string }) =>
        useTargetMutation(target, {
          mutationFn: (value: string, scope) => run(label, value, scope.target),
          onSuccess: (_data, _value, scope) => complete(label, scope.target),
        }),
      {
        wrapper,
        initialProps: {
          target: mutable as ManagementTarget,
          label: "original",
        },
      },
    );
    let finished!: Promise<unknown>;
    act(() => {
      finished = result.current.mutateAsync("input");
    });
    mutable.profile.host = "192.0.2.6";
    mutable.secret = { password: "changed-after-submit" };
    rerender({ target: local, label: "replacement" });
    await act(async () => {
      await finished;
    });
    expect(run.mock.calls).toEqual([["original", "input", original]]);
    expect(complete.mock.calls).toEqual([["original", original]]);
  });

  it("keeps two overlapping operations bound when they finish out of order", async () => {
    const pending = new Map<string, (value: string) => void>();
    const run = vi.fn(
      (value: string) =>
        new Promise<string>((resolve) => pending.set(value, resolve)),
    );
    const completed = vi.fn();
    const { wrapper } = setup();
    const { result, rerender } = renderHook(
      ({ target }: { target: ManagementTarget }) =>
        useTargetMutation(target, {
          mutationFn: (value: string, scope) =>
            run(`${scope.target.type}:${value}`),
          onSuccess: (data, value, scope) =>
            completed(data, value, scope.target.type),
        }),
      { wrapper, initialProps: { target: remote as ManagementTarget } },
    );
    let first!: Promise<string>;
    let second!: Promise<string>;
    act(() => {
      first = result.current.mutateAsync("first");
    });
    rerender({ target: local });
    act(() => {
      second = result.current.mutateAsync("second");
    });
    await waitFor(() => expect(run).toHaveBeenCalledTimes(2));
    await act(async () => {
      pending.get("local:second")!("second result");
      await second;
    });
    await act(async () => {
      pending.get("remote:first")!("first result");
      await first;
    });
    expect(completed.mock.calls).toEqual([
      ["second result", "second", "local"],
      ["first result", "first", "remote"],
    ]);
  });

  it("preserves per-call callbacks and public variables without exposing the binding envelope", async () => {
    const onSuccess = vi.fn();
    const onSettled = vi.fn();
    const { wrapper } = setup();
    const { result } = renderHook(
      () =>
        useTargetMutation(remote, {
          mutationFn: async (value: { id: string }) => value.id,
        }),
      { wrapper },
    );
    await act(async () => {
      expect(
        await result.current.mutateAsync(
          { id: "profile" },
          { onSuccess, onSettled },
        ),
      ).toBe("profile");
    });
    await waitFor(() => expect(result.current.isSuccess).toBe(true));
    expect(result.current.variables).toEqual({ id: "profile" });
    expect(onSuccess.mock.calls[0].slice(0, 3)).toEqual([
      "profile",
      { id: "profile" },
      undefined,
    ]);
    expect(onSettled.mock.calls[0].slice(0, 3)).toEqual([
      "profile",
      null,
      { id: "profile" },
    ]);
  });

  it("does not retry a failed write or call success callbacks", async () => {
    const failure = new Error("rejected");
    const run = vi.fn().mockRejectedValue(failure);
    const onError = vi.fn();
    const onSuccess = vi.fn();
    const perCallError = vi.fn();
    const { wrapper } = setup();
    const { result } = renderHook(
      () => useTargetMutation(remote, { mutationFn: run, onError, onSuccess }),
      { wrapper },
    );
    await act(async () => {
      await expect(
        result.current.mutateAsync("input", { onError: perCallError }),
      ).rejects.toThrow("rejected");
    });
    expect(run).toHaveBeenCalledTimes(1);
    expect(onSuccess).not.toHaveBeenCalled();
    expect(onError).toHaveBeenCalledWith(
      failure,
      "input",
      expect.objectContaining({ target: remote }),
    );
    expect(perCallError.mock.calls[0].slice(0, 2)).toEqual([failure, "input"]);
  });
});
