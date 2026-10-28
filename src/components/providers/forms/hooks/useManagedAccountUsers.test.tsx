import { renderHook } from "@testing-library/react";
import { beforeEach, describe, expect, it, vi } from "vitest";
import type { ManagementTarget } from "@/lib/api";
import { useManagedAccountUsers } from "./useManagedAccountUsers";

const query = vi.hoisted(() => vi.fn());
vi.mock("@/lib/query", () => ({ useProvidersQuery: query }));

describe("managed account users target routing", () => {
  beforeEach(() => query.mockReset().mockReturnValue({ data: undefined }));

  it("loads provider bindings only for the selected remote target", () => {
    const target: ManagementTarget = {
      type: "remote",
      profile: {
        id: "host",
        host: "example.test",
        port: 22,
        username: "user",
        name: "Host",
        authMethod: { type: "sshAgent" },
        helperPath: "helper",
        createdAt: 1,
        updatedAt: 1,
      },
      secret: { password: "remote-secret" },
    };
    renderHook(() => useManagedAccountUsers("codex_oauth", null, target));
    expect(query).toHaveBeenCalledWith("claude", { target });
    expect(query).toHaveBeenCalledWith("codex", { target });
    expect(query).toHaveBeenCalledWith("claude-desktop", {
      target,
      enabled: false,
    });
    expect(query).toHaveBeenCalledWith("agy", { target, enabled: false });
    expect(
      query.mock.calls.every(([, options]) => options.target === target),
    ).toBe(true);
  });

  it("retains the original local provider readers", () => {
    renderHook(() => useManagedAccountUsers("codex_oauth", null));
    expect(query).toHaveBeenCalledWith("claude", { target: undefined });
    expect(query).toHaveBeenCalledWith("claude-desktop", {
      target: undefined,
      enabled: true,
    });
    expect(query).toHaveBeenCalledWith("agy", {
      target: undefined,
      enabled: true,
    });
  });
});
