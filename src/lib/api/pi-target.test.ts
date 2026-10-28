import { beforeEach, describe, expect, it, vi } from "vitest";
import { piApi } from "./pi";
import { providersApi } from "./providers";
import { proxyApi } from "./proxy";
import { usageApi } from "./usage";
import { toolEnvironmentApi } from "./toolEnvironment";
import type { ManagementTarget } from "./remote";
const invoke = vi.hoisted(() => vi.fn());
vi.mock("@tauri-apps/api/core", () => ({ invoke }));
vi.mock("@tauri-apps/api/event", () => ({ listen: vi.fn() }));
const target: ManagementTarget = {
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
const script = {
  enabled: true,
  language: "javascript" as const,
  code: "return {}",
};
describe("Pi-family and new upstream target boundaries", () => {
  beforeEach(() => invoke.mockReset());
  it.each(["pi", "omp"] as const)(
    "reads %s state and saves usage metadata on the selected remote host",
    async (app) => {
      const state = { enabledProviderIds: ["p"], defaultProviderId: "p" };
      invoke.mockResolvedValueOnce(state).mockResolvedValueOnce(true);
      await expect(piApi.getCurrentState(app, target)).resolves.toEqual(state);
      await piApi.updateProviderUsageScript("p", script, app, target);
      expect(invoke.mock.calls).toEqual([
        [
          "remote_get_pi_current_state",
          { profile: target.profile, app, secret: target.secret },
        ],
        [
          "remote_update_pi_provider_usage_script",
          {
            profile: target.profile,
            app,
            id: "p",
            usageScript: script,
            secret: target.secret,
          },
        ],
      ]);
    },
  );
  it.each(["pi", "omp"] as const)(
    "preserves local %s commands",
    async (app) => {
      await piApi.getCurrentState(app);
      await piApi.updateProviderUsageScript("p", script, app);
      expect(invoke.mock.calls).toEqual([
        [`get_${app}_current_state`],
        [
          "update_pi_provider_usage_script",
          { app, id: "p", usageScript: script },
        ],
      ]);
    },
  );
  it("routes OpenCode default-model reads and writes to the remote helper", async () => {
    await providersApi.getOpenCodeDefaultModel(target);
    await providersApi.setOpenCodeDefaultModel("p/model", target);
    expect(invoke.mock.calls).toEqual([
      [
        "remote_get_opencode_default_model",
        { profile: target.profile, secret: target.secret },
      ],
      [
        "remote_set_opencode_default_model",
        { profile: target.profile, model: "p/model", secret: target.secret },
      ],
    ]);
  });
  it("routes heatmap first-date filters to the same host", async () => {
    await usageApi.getUsageFirstDate("omp", "provider", "model", target);
    expect(invoke).toHaveBeenCalledWith("remote_get_usage_first_date", {
      profile: target.profile,
      appType: "omp",
      providerName: "provider",
      model: "model",
      secret: target.secret,
    });
  });
  it("refuses unsupported operations before any local command runs", async () => {
    await expect(proxyApi.getProxyClientHost(target)).rejects.toThrow(
      "routing-client-host",
    );
    await expect(
      proxyApi.setProxyClientHost("localhost", target),
    ).rejects.toThrow("routing-client-host");
    await expect(proxyApi.acknowledgeCodexStaleClients(target)).rejects.toThrow(
      "codex-stale-clients",
    );
    await expect(
      toolEnvironmentApi.prepareToolUninstall("omp", undefined, target),
    ).rejects.toThrow("tool-uninstall");
    await expect(
      toolEnvironmentApi.runToolLifecycleAction(
        ["omp"],
        "uninstall",
        undefined,
        target,
      ),
    ).rejects.toThrow("tool-uninstall");
    expect(invoke).not.toHaveBeenCalled();
  });
});
