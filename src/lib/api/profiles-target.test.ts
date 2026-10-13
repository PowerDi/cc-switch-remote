import { beforeEach, describe, expect, it, vi } from "vitest";
import { profilesApi, type ProfileScope } from "./profiles";
import type { ManagementTarget } from "./remote";

const invokeMock = vi.hoisted(() => vi.fn());
vi.mock("@tauri-apps/api/core", () => ({
  invoke: (...args: unknown[]) => invokeMock(...args),
}));

const remoteTarget: ManagementTarget = {
  type: "remote",
  profile: {
    id: "remote-host",
    name: "Remote Host",
    host: "192.0.2.10",
    port: 22,
    username: "root",
    authMethod: { type: "sshAgent" },
    helperPath: "/root/.local/bin/cc-switch-remote-helper",
    createdAt: 1,
    updatedAt: 1,
  },
  secret: { password: "test-secret" },
};

const operations = [
  {
    name: "list",
    command: "list_profiles",
    remote: "remote_list_project_profiles",
    args: undefined,
    run: (target: ManagementTarget) => profilesApi.list(target),
  },
  {
    name: "create",
    command: "create_profile",
    remote: "remote_create_project_profile",
    args: { name: "Project", scope: "codex" },
    run: (target: ManagementTarget) =>
      profilesApi.create("Project", "codex", target),
  },
  {
    name: "update",
    command: "update_profile",
    remote: "remote_update_project_profile",
    args: {
      id: "project",
      name: "Renamed",
      resnapshot: true,
      scope: "claude-desktop",
    },
    run: (target: ManagementTarget) =>
      profilesApi.update(
        "project",
        { name: "Renamed", resnapshot: true, scope: "claude-desktop" },
        target,
      ),
  },
  {
    name: "delete",
    command: "delete_profile",
    remote: "remote_delete_project_profile",
    args: { id: "project" },
    run: (target: ManagementTarget) => profilesApi.delete("project", target),
  },
  {
    name: "apply",
    command: "apply_profile",
    remote: "remote_apply_project_profile",
    args: { id: "project", scope: "claude" },
    run: (target: ManagementTarget) =>
      profilesApi.apply("project", "claude", target),
  },
  {
    name: "clear",
    command: "clear_current_profile",
    remote: "remote_clear_current_project_profile",
    args: { scope: "codex" },
    run: (target: ManagementTarget) =>
      profilesApi.clearCurrent("codex", target),
  },
];

describe("profilesApi full target routing", () => {
  beforeEach(() => invokeMock.mockReset());
  it.each(operations)(
    "$name keeps the local command and payload",
    async ({ run, command, args }) => {
      invokeMock.mockResolvedValueOnce(undefined);
      await run({ type: "local" });
      expect(invokeMock.mock.calls).toEqual([
        args === undefined ? [command] : [command, args],
      ]);
    },
  );
  it.each(operations)(
    "$name routes exclusively through the selected SSH profile/secret",
    async ({ run, remote, args }) => {
      invokeMock.mockResolvedValueOnce(undefined);
      await run(remoteTarget);
      expect(invokeMock.mock.calls).toEqual([
        [
          remote,
          {
            ...args,
            profile: remoteTarget.profile,
            secret: remoteTarget.secret,
          },
        ],
      ]);
    },
  );
  it.each(["claude", "claude-desktop", "codex"] satisfies ProfileScope[])(
    "preserves the %s scope and backend warnings",
    async (scope) => {
      const warnings = ["missing provider", "prompt unchanged"];
      invokeMock.mockResolvedValueOnce(warnings);
      expect(await profilesApi.apply("project", scope, remoteTarget)).toBe(
        warnings,
      );
      expect(invokeMock).toHaveBeenCalledWith("remote_apply_project_profile", {
        profile: remoteTarget.profile,
        secret: remoteTarget.secret,
        id: "project",
        scope,
      });
    },
  );
  it("preserves a remote failure without retrying a local command", async () => {
    invokeMock.mockRejectedValueOnce(new Error("helper rejected"));
    await expect(
      profilesApi.create("Project", "codex", remoteTarget),
    ).rejects.toThrow("helper rejected");
    expect(invokeMock).toHaveBeenCalledTimes(1);
  });
});
