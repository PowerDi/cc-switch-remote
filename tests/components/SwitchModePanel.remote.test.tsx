import { fireEvent, render, screen, waitFor } from "@testing-library/react";
import { QueryClientProvider } from "@tanstack/react-query";
import { beforeEach, describe, expect, it, vi } from "vitest";
import { http, HttpResponse } from "msw";
import { toast } from "sonner";
import type { Provider } from "@/types";
import type { ManagementTarget } from "@/lib/api/remote";
import { SwitchModePanel } from "@/components/providers/mode/SwitchModePanel";
import { server } from "../msw/server";
import { createTestQueryClient } from "../utils/testQueryClient";

vi.mock("sonner", () => ({
  toast: {
    success: vi.fn(),
    info: vi.fn(),
    warning: vi.fn(),
    error: vi.fn(),
  },
}));

vi.mock("@/components/providers/ProviderCard", () => ({
  ProviderCard: ({ provider, presentation }: any) => (
    <div data-testid={`card-${provider.id}`}>
      {presentation.buttons.map((button: any) => (
        <button
          key={button.key}
          data-testid={`${button.key}-${provider.id}`}
          disabled={Boolean(button.disabledReason)}
          onClick={button.onClick}
        >
          {button.label}
        </button>
      ))}
    </div>
  ),
}));

vi.mock("@/hooks/useStreamCheck", () => ({
  useStreamCheck: () => ({ checkProvider: vi.fn(), isChecking: () => false }),
}));

const TAURI_ENDPOINT = "http://tauri.local";

const remoteTarget: ManagementTarget = {
  type: "remote",
  profile: {
    id: "server-a",
    name: "Server A",
    host: "192.0.2.10",
    port: 22,
    username: "root",
    authMethod: { type: "sshAgent" },
    helperPath: "/root/.local/bin/cc-switch-remote-helper",
    createdAt: 1,
    updatedAt: 1,
  },
  secret: { password: "secret" },
};

const provider = (id: string): Provider => ({
  id,
  name: id,
  settingsConfig: {},
});

/** 远端命令请求记录；本机命令一旦被调用就记在 localCalls 里（用于反向断言）。 */
let remoteCalls: { command: string; body: any }[] = [];
let localCalls: string[] = [];

function mockRemote(capabilities = ["providers", "app-mode", "settings"]) {
  remoteCalls = [];
  localCalls = [];
  server.use(
    http.post(`${TAURI_ENDPOINT}/remote_check_health`, () =>
      HttpResponse.json({
        reachable: true,
        helperInstalled: true,
        helperVersion: "4.0.5",
        platform: "linux",
        capabilities,
      }),
    ),
    http.post(`${TAURI_ENDPOINT}/remote_get_app_mode`, async ({ request }) => {
      remoteCalls.push({
        command: "remote_get_app_mode",
        body: await request.json(),
      });
      return HttpResponse.json({
        mode: "direct",
        attached: false,
        routeProviderId: null,
        directProviderId: null,
      });
    }),
    http.post(`${TAURI_ENDPOINT}/remote_set_app_mode`, async ({ request }) => {
      remoteCalls.push({
        command: "remote_set_app_mode",
        body: await request.json(),
      });
      return HttpResponse.json(null);
    }),
    http.post(`${TAURI_ENDPOINT}/remote_get_providers`, () =>
      HttpResponse.json({
        providers: { p1: provider("p1") },
        currentProviderId: "p1",
      }),
    ),
    http.post(`${TAURI_ENDPOINT}/remote_get_settings`, () =>
      HttpResponse.json({}),
    ),
    http.post(`${TAURI_ENDPOINT}/remote_get_routing_runtime_status`, () =>
      HttpResponse.json({ running: false, address: "127.0.0.1", port: 15721 }),
    ),
    // 本机模式命令不该在远端路径上出现：出现就算失败
    http.post(`${TAURI_ENDPOINT}/get_app_mode`, () => {
      localCalls.push("get_app_mode");
      return HttpResponse.json({ mode: "direct" });
    }),
    http.post(`${TAURI_ENDPOINT}/get_proxy_status`, () => {
      localCalls.push("get_proxy_status");
      return HttpResponse.json({ running: false });
    }),
  );

  // 模式行还会读故障转移/健康状态等：给个兜底，避免无关噪音影响断言
  for (const command of [
    "remote_get_auto_failover_enabled",
    "remote_get_failover_queue",
    "remote_get_available_providers_for_failover",
    "remote_get_provider_health",
  ]) {
    server.use(
      http.post(`${TAURI_ENDPOINT}/${command}`, () => HttpResponse.json(false)),
    );
  }
}

function renderPanel(target: ManagementTarget = remoteTarget) {
  const queryClient = createTestQueryClient();
  return render(
    <QueryClientProvider client={queryClient}>
      <SwitchModePanel
        app="claude"
        target={target}
        providers={{ p1: provider("p1") }}
        currentProviderId="p1"
        isLoading={false}
        onSwitch={vi.fn()}
        onOpenRoutingSettings={vi.fn()}
        onEdit={vi.fn()}
        onDelete={vi.fn()}
        onDuplicate={vi.fn()}
        onOpenWebsite={vi.fn()}
      />
    </QueryClientProvider>,
  );
}

beforeEach(() => {
  vi.mocked(toast.error).mockClear();
  Element.prototype.scrollIntoView = vi.fn();
});

describe("SwitchModePanel — 远端目标", () => {
  it("远端模式状态经 helper 读取，且不走本机命令", async () => {
    mockRemote();
    renderPanel();

    await waitFor(() =>
      expect(
        remoteCalls.some((call) => call.command === "remote_get_app_mode"),
      ).toBe(true),
    );
    const call = remoteCalls.find(
      (entry) => entry.command === "remote_get_app_mode",
    );
    expect(call?.body).toMatchObject({
      appType: "claude",
      profile: { id: "server-a" },
      secret: { password: "secret" },
    });
    expect(localCalls).toEqual([]);
  });

  it("进入路由模式写的是那台主机的模式状态", async () => {
    mockRemote();
    renderPanel();

    // 先看到「路由」那一格，再从通知条进入（Claude 没有聚合模式）
    fireEvent.click(
      await screen.findByRole("button", { name: /mode\.names\.route/ }),
    );
    fireEvent.click(
      await screen.findByRole("button", { name: "mode.activate.route" }),
    );
    fireEvent.click(
      await screen.findByRole("button", { name: "mode.dialog.confirmRoute" }),
    );

    await waitFor(() =>
      expect(
        remoteCalls.some((call) => call.command === "remote_set_app_mode"),
      ).toBe(true),
    );
    const call = remoteCalls.find(
      (entry) => entry.command === "remote_set_app_mode",
    );
    expect(call?.body).toMatchObject({
      appType: "claude",
      enabled: true,
      stack: false,
      profile: { id: "server-a" },
    });
    expect(localCalls).toEqual([]);
  });

  it("旧 helper 没有 app-mode 能力时说明不支持，且不发模式命令", async () => {
    mockRemote(["providers", "settings"]);
    renderPanel();

    expect(
      (await screen.findAllByRole("status")).some((element) =>
        /不支持按应用切换/.test(element.textContent ?? ""),
      ),
    ).toBe(true);
    // 能力不支持时不发任何模式命令
    expect(
      remoteCalls.some((call) => call.command === "remote_get_app_mode"),
    ).toBe(false);
    expect(
      remoteCalls.some((call) => call.command === "remote_set_app_mode"),
    ).toBe(false);
    expect(localCalls).toEqual([]);
  });
});
