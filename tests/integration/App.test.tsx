import { Suspense, type ComponentType } from "react";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import {
  act,
  render,
  screen,
  waitFor,
  fireEvent,
  within,
} from "@testing-library/react";
import { describe, it, expect, beforeEach, vi } from "vitest";
import { providersApi } from "@/lib/api/providers";
import {
  resetProviderState,
  getLastRemoteSaveSecret,
  getRemoteOpenClawDefaultModel,
  setCurrentProviderId,
  setLiveProviderIds,
  setProviders,
  setRemoteProviderStateError,
  setRemoteProfiles,
  setRemoteSettings,
  setSessionFixtures,
  setSettings,
} from "../msw/state";
import { http, HttpResponse } from "msw";
import { server } from "../msw/server";
import { emitTauriEvent } from "../msw/tauriMocks";

const toastSuccessMock = vi.fn();
const toastErrorMock = vi.fn();
const skillsPanelMocks = vi.hoisted(() => ({
  initialViews: [] as string[],
}));
const windowMocks = vi.hoisted(() => ({
  isLinux: vi.fn(() => false),
  isMaximized: vi.fn(),
  isFullscreen: vi.fn(),
  isResizable: vi.fn(),
  scaleFactor: vi.fn(),
  setDecorations: vi.fn(async () => {}),
  resizeListeners: new Set<() => void>(),
  onResized: vi.fn(),
  onScaleChanged: vi.fn(),
}));

vi.mock("@/lib/platform", async (importOriginal) => ({
  ...(await importOriginal<typeof import("@/lib/platform")>()),
  isLinux: windowMocks.isLinux,
}));

vi.mock("@tauri-apps/api/window", () => ({
  getCurrentWindow: () => windowMocks,
}));

vi.mock("sonner", () => ({
  toast: {
    success: (...args: unknown[]) => toastSuccessMock(...args),
    error: (...args: unknown[]) => toastErrorMock(...args),
  },
}));

vi.mock("@/components/providers/ProviderList", () => ({
  ProviderList: ({
    providers,
    currentProviderId,
    target,
    onSwitch,
    onEdit,
    onDuplicate,
    onConfigureUsage,
    onOpenWebsite,
    onCreate,
    onDelete,
    onRemoveFromConfig,
    onSetAsDefault,
    onTest,
    onToggleFailover,
  }: any) => (
    <div>
      <div data-testid="provider-list">{JSON.stringify(providers)}</div>
      <div data-testid="current-provider">{currentProviderId}</div>
      <div data-testid="provider-target">{target?.type ?? "local"}</div>
      <button onClick={() => onSwitch(providers[currentProviderId])}>
        switch
      </button>
      <button onClick={() => onEdit(providers[currentProviderId])}>edit</button>
      <button onClick={() => onDuplicate(providers[currentProviderId])}>
        duplicate
      </button>
      <button onClick={() => onConfigureUsage(providers[currentProviderId])}>
        usage
      </button>
      <button onClick={() => onOpenWebsite("https://example.com")}>
        open-website
      </button>
      <button onClick={() => onCreate?.()}>create</button>
      <button onClick={() => onDelete(Object.values(providers)[0])}>
        delete
      </button>
      <button onClick={() => onRemoveFromConfig?.(Object.values(providers)[0])}>
        remove
      </button>
      <button onClick={() => onTest?.(providers[currentProviderId])}>
        test
      </button>
      <button
        onClick={() => onToggleFailover?.(true, providers[currentProviderId])}
      >
        toggle-failover
      </button>
      <button onClick={() => onSetAsDefault?.(providers[currentProviderId])}>
        set-default
      </button>
    </div>
  ),
}));

vi.mock("@/components/providers/AddProviderDialog", () => ({
  AddProviderDialog: ({ open, onOpenChange, onSubmit, appId }: any) =>
    open ? (
      <div data-testid="add-provider-dialog">
        <button
          onClick={() =>
            onSubmit({
              name: `New ${appId} Provider`,
              settingsConfig: {},
              category: "custom",
              sortIndex: 99,
            })
          }
        >
          confirm-add
        </button>
        <button onClick={() => onOpenChange(false)}>close-add</button>
      </div>
    ) : null,
}));

vi.mock("@/components/providers/EditProviderDialog", async () => {
  const { useUnsavedChangesTracker } = await vi.importActual<
    typeof import("@/lib/unsavedChanges")
  >("@/lib/unsavedChanges");
  // 和真的编辑页一样登记改动（真的由 FullScreenPanel 的 trackUnsavedChanges 负责）
  const Body = ({ provider, onSubmit, onOpenChange }: any) => (
    <div data-testid="edit-provider-dialog" {...useUnsavedChangesTracker()}>
      <input aria-label="edit-field" />
      <button
        onClick={() =>
          onSubmit({
            provider: {
              ...provider,
              name: `${provider.name}-edited`,
            },
            originalId: provider.id,
          })
        }
      >
        confirm-edit
      </button>
      <button onClick={() => onOpenChange(false)}>close-edit</button>
    </div>
  );
  return {
    EditProviderDialog: (props: any) =>
      props.open ? <Body {...props} /> : null,
  };
});

vi.mock("@/components/UsageScriptModal", () => ({
  default: ({ isOpen, provider, onSave, onClose }: any) =>
    isOpen ? (
      <div data-testid="usage-modal">
        <span data-testid="usage-provider">{provider?.id}</span>
        <button onClick={() => onSave("script-code")}>save-script</button>
        <button onClick={() => onClose()}>close-usage</button>
      </div>
    ) : null,
}));

vi.mock("@/components/ConfirmDialog", () => ({
  ConfirmDialog: ({ isOpen, message, onConfirm, onCancel }: any) =>
    isOpen ? (
      <div data-testid="confirm-dialog">
        <div data-testid="confirm-message">{message}</div>
        <button onClick={() => onConfirm()}>confirm-delete</button>
        <button onClick={() => onCancel()}>cancel-delete</button>
      </div>
    ) : null,
}));

const updateMocks = vi.hoisted(() => ({ hasUpdate: false }));

vi.mock("@/contexts/UpdateContext", () => ({
  useUpdate: () => ({
    hasUpdate: updateMocks.hasUpdate,
    updateInfo: updateMocks.hasUpdate ? { version: "9.9.9" } : null,
  }),
}));

// v4 已删除 AppSwitcher（应用切换在 Sidebar 里），这里只保留远程目标切换器
vi.mock("@/components/remote/ManagementTargetSwitcher", () => ({
  ManagementTargetSwitcher: ({
    profiles,
    activeTargetKey,
    onTargetChange,
    onManageServers,
  }: any) => (
    <div
      data-testid="management-target-switcher"
      data-active-target-key={activeTargetKey}
    >
      <button onClick={() => onTargetChange("local")}>target-local</button>
      {profiles.map((profile: any) => (
        <button
          key={profile.id}
          onClick={() => onTargetChange(`remote:${profile.id}`)}
        >
          {profile.name}
        </button>
      ))}
      <button onClick={() => onManageServers?.()}>manage-servers</button>
    </div>
  ),
}));

vi.mock("@/components/proxy/ProxyToggle", () => ({
  ProxyToggle: () => <div data-testid="proxy-toggle" />,
}));

vi.mock("@/components/proxy/FailoverToggle", () => ({
  FailoverToggle: () => <div data-testid="failover-toggle" />,
}));

vi.mock("@/components/proxy/RemoteRoutingToggle", () => ({
  RemoteRoutingToggle: () => <div data-testid="remote-routing-toggle" />,
}));

vi.mock("@/components/proxy/RemoteAppRoutingToggle", () => ({
  RemoteAppRoutingToggle: ({ activeApp }: any) => (
    <div data-testid="remote-app-routing-toggle">{activeApp}</div>
  ),
}));

vi.mock("@/components/proxy/ClaudeDesktopRouteToggle", () => ({
  ClaudeDesktopRouteToggle: () => <div data-testid="desktop-route-toggle" />,
}));

vi.mock("@/components/settings/SettingsPage", () => ({
  SettingsPage: ({ section, defaultTab, onImportSuccess, target }: any) => (
    <div data-testid="settings-page">
      <span data-testid="settings-target">{target?.type ?? "local"}</span>
      <span data-testid="settings-default-tab">{section ?? defaultTab}</span>
      <button onClick={() => onImportSuccess?.()}>
        simulate-import-success
      </button>
    </div>
  ),
}));

vi.mock("@/components/settings/RemoteSettingsPage", () => ({
  RemoteSettingsPage: ({
    onImportSuccess,
    onOpenChange,
    onSettingsSaved,
    onInteractionBlockedChange,
    defaultTab,
    target,
  }: any) => (
    <div data-testid="settings-page">
      <span data-testid="settings-target">{target?.type ?? "local"}</span>
      <span data-testid="settings-default-tab">{defaultTab}</span>
      <button
        onClick={() =>
          onSettingsSaved?.({
            visibleApps: {
              claude: false,
              "claude-desktop": false,
              codex: false,
              gemini: true,
              grokbuild: false,
              opencode: false,
              openclaw: false,
              hermes: false,
            },
          })
        }
      >
        simulate-remote-settings-saved
      </button>
      <button onClick={() => onImportSuccess?.()}>
        simulate-import-success
      </button>
      <button onClick={() => onOpenChange?.(false)}>close-settings</button>
      <button onClick={() => onInteractionBlockedChange?.(true)}>
        remote-settings-busy
      </button>
      <button onClick={() => onInteractionBlockedChange?.(false)}>
        remote-settings-idle
      </button>
    </div>
  ),
}));

vi.mock("@/components/mcp/McpPanel", () => ({
  default: ({ open, onOpenChange }: any) =>
    open ? (
      <div data-testid="mcp-panel">
        <button onClick={() => onOpenChange(false)}>close-mcp</button>
      </div>
    ) : (
      <button onClick={() => onOpenChange(true)}>open-mcp</button>
    ),
}));

vi.mock("@/components/mcp/UnifiedMcpPanel", async () => {
  const { useUnsavedChangesTracker } = await vi.importActual<
    typeof import("@/lib/unsavedChanges")
  >("@/lib/unsavedChanges");
  const React = await vi.importActual<typeof import("react")>("react");
  return {
    default: React.forwardRef(function UnifiedMcpPanelMock(
      { target, onInteractionBlockedChange }: any,
      _ref,
    ) {
      return (
        <div data-testid="unified-mcp-panel">
          <div data-testid="mcp-editor" {...useUnsavedChangesTracker()}>
            <input aria-label="mcp-field" />
          </div>
          <span data-testid="mcp-management-target">
            {target?.type === "remote" ? target.profile.id : "local"}
          </span>
          <button onClick={() => onInteractionBlockedChange?.(true)}>
            set-mcp-busy
          </button>
        </div>
      );
    }),
  };
});

vi.mock("@/components/skills/UnifiedSkillsPanel", async () => {
  const React = await vi.importActual<typeof import("react")>("react");
  return {
    // 既要记录上游的 initialView（发现段），也要暴露目标与忙碌回调
    default: React.forwardRef(function UnifiedSkillsPanelMock(
      {
        target,
        initialView,
        onInteractionBlockedChange,
        onNavigationBlockedChange,
      }: any,
      _ref,
    ) {
      skillsPanelMocks.initialViews.push(initialView ?? "installed");
      return (
        <div data-testid="unified-skills-panel">
          <span data-testid="skills-management-target">
            {target?.type === "remote" ? target.profile.id : "local"}
          </span>
          <span data-testid="skills-initial-view">{initialView}</span>
          <button
            onClick={() => {
              onInteractionBlockedChange?.(true);
              onNavigationBlockedChange?.(false);
            }}
          >
            set-skills-checking
          </button>
        </div>
      );
    }),
  };
});

vi.mock("@/components/MarkdownEditor", () => ({
  default: ({ value, onChange }: any) => (
    <textarea
      data-testid="markdown-editor"
      value={value}
      onChange={(event) => onChange(event.target.value)}
    />
  ),
}));
/** 侧栏里的应用行（v7 侧栏取代了原来页头的应用切换器） */
const sidebarApp = (name: string) =>
  // 首次启动提示是模态对话框，会把侧栏标成 aria-hidden，所以带上 hidden
  within(document.querySelector("nav") as HTMLElement).getByRole("button", {
    name,
    hidden: true,
  });

/** 侧栏里有没有这个应用行（用于"按主机隐藏应用"的断言） */
const querySidebarApp = (name: string) =>
  within(document.querySelector("nav") as HTMLElement).queryByRole("button", {
    name,
    hidden: true,
  });

/** 侧栏的全局入口（MCP / Skills / 提示词 / 会话 / 授权中心 / 用量统计 / 设置） */
const navButton = (name: string) =>
  within(document.querySelector("nav") as HTMLElement).getByRole("button", {
    name,
    hidden: true,
  });

const renderApp = (AppComponent: ComponentType) => {
  const client = new QueryClient();
  return render(
    <QueryClientProvider client={client}>
      <Suspense fallback={<div data-testid="loading">loading</div>}>
        <AppComponent />
      </Suspense>
    </QueryClientProvider>,
  );
};

describe("App integration with MSW", () => {
  beforeEach(() => {
    localStorage.clear();
    sessionStorage.clear();
    resetProviderState();
    toastSuccessMock.mockReset();
    toastErrorMock.mockReset();
    updateMocks.hasUpdate = false;
    // ── fork 远程集成用例（保留） ───────────────────────────────────────────
    skillsPanelMocks.initialViews = [];
    windowMocks.isLinux.mockReturnValue(false);
    windowMocks.isMaximized.mockResolvedValue(false);
    windowMocks.isFullscreen.mockResolvedValue(false);
    windowMocks.isResizable.mockResolvedValue(true);
    windowMocks.scaleFactor.mockResolvedValue(1);
    windowMocks.resizeListeners.clear();
    const listen = async (handler: () => void) => {
      windowMocks.resizeListeners.add(handler);
      return () => windowMocks.resizeListeners.delete(handler);
    };
    windowMocks.onResized.mockImplementation(listen);
    windowMocks.onScaleChanged.mockImplementation(listen);
    localStorage.removeItem("cc-switch-last-view");
    localStorage.removeItem("cc-switch-last-app");
  });

  it("keeps the remote target switcher and MCP actions usable while management writes are guarded", async () => {
    setSettings({ firstRunNoticeConfirmed: true });
    setRemoteProfiles([
      {
        id: "server-a",
        name: "Server A",
        host: "192.0.2.10",
        port: 22,
        username: "root",
        authMethod: { type: "sshAgent" },
        helperPath: "~/.local/bin/cc-switch-remote-helper",
        createdAt: 1,
        updatedAt: 1,
      },
    ]);

    const { default: App } = await import("@/App");
    renderApp(App);

    fireEvent.click(await screen.findByText("Server A"));
    fireEvent.click(navButton("MCP"));

    // MCP panel reads the selected target (and shows it)
    await waitFor(() =>
      expect(screen.getByTestId("mcp-management-target")).toHaveTextContent(
        "server-a",
      ),
    );
    expect(
      screen.getByTestId("management-target-switcher"),
    ).toBeInTheDocument();

    // A write is in flight: the switcher stays visible, but switching does nothing
    fireEvent.click(screen.getByText("set-mcp-busy"));
    fireEvent.click(screen.getByText("target-local"));
    expect(screen.getByTestId("mcp-management-target")).toHaveTextContent(
      "server-a",
    );
    expect(
      screen.getByTestId("management-target-switcher"),
    ).toBeInTheDocument();
    // 这个用例要等完整 App + MSW 起来再跑两次交互，并行跑全量时 20s 不够
  }, 45_000);

  it("keeps the selected target fixed while managed authentication is busy", async () => {
    setSettings({ firstRunNoticeConfirmed: true });
    setRemoteProfiles([
      {
        id: "server-a",
        name: "Server A",
        host: "192.0.2.10",
        port: 22,
        username: "root",
        authMethod: { type: "sshAgent" },
        helperPath: "~/.local/bin/cc-switch-remote-helper",
        createdAt: 1,
        updatedAt: 1,
      },
    ]);

    const { default: App } = await import("@/App");
    renderApp(App);

    fireEvent.click(await screen.findByText("Server A"));
    fireEvent.click(navButton("nav.settings"));
    await waitFor(() =>
      expect(screen.getByTestId("settings-target")).toHaveTextContent("remote"),
    );

    // 认证/设备码轮询在跑：目标选择还在，但切目标不生效
    fireEvent.click(screen.getByText("remote-settings-busy"));
    fireEvent.click(screen.getByText("target-local"));
    expect(screen.getByTestId("settings-target")).toHaveTextContent("remote");

    fireEvent.click(screen.getByText("remote-settings-idle"));
    fireEvent.click(screen.getByText("target-local"));
    await waitFor(() =>
      expect(screen.getByTestId("settings-target")).toHaveTextContent("local"),
    );
  }, 20_000);

  it("keeps the selected target fixed while Skills checks for updates", async () => {
    setSettings({ firstRunNoticeConfirmed: true });
    setRemoteProfiles([
      {
        id: "server-a",
        name: "Server A",
        host: "192.0.2.10",
        port: 22,
        username: "root",
        authMethod: { type: "sshAgent" },
        helperPath: "~/.local/bin/cc-switch-remote-helper",
        createdAt: 1,
        updatedAt: 1,
      },
    ]);

    const { default: App } = await import("@/App");
    renderApp(App);

    fireEvent.click(await screen.findByText("Server A"));
    fireEvent.click(navButton("Skills"));
    await waitFor(() =>
      expect(screen.getByTestId("skills-management-target")).toHaveTextContent(
        "server-a",
      ),
    );

    // 检查更新进行中：目标选择还在，但切目标不生效
    fireEvent.click(screen.getByText("set-skills-checking"));
    fireEvent.click(screen.getByText("target-local"));

    expect(screen.getByTestId("skills-management-target")).toHaveTextContent(
      "server-a",
    );
    expect(
      screen.getByTestId("management-target-switcher"),
    ).toBeInTheDocument();
    skillsPanelMocks.initialViews = [];
  }, 20_000);

  it("covers basic provider flows via real hooks", async () => {
    const { default: App } = await import("@/App");
    renderApp(App);

    await waitFor(() =>
      expect(screen.getByTestId("provider-list").textContent).toContain(
        "claude-1",
      ),
    );

    fireEvent.click(sidebarApp("Codex"));
    await waitFor(() =>
      expect(screen.getByTestId("provider-list").textContent).toContain(
        "codex-1",
      ),
    );

    fireEvent.click(screen.getByText("usage"));
    expect(screen.getByTestId("usage-modal")).toBeInTheDocument();
    fireEvent.click(screen.getByText("save-script"));
    fireEvent.click(screen.getByText("close-usage"));

    fireEvent.click(screen.getByText("create"));
    expect(screen.getByTestId("add-provider-dialog")).toBeInTheDocument();
    fireEvent.click(screen.getByText("confirm-add"));
    await waitFor(() =>
      expect(screen.getByTestId("provider-list").textContent).toMatch(
        /New codex Provider/,
      ),
    );

    fireEvent.click(screen.getByText("edit"));
    expect(screen.getByTestId("edit-provider-dialog")).toBeInTheDocument();
    fireEvent.click(screen.getByText("confirm-edit"));
    await waitFor(() =>
      expect(screen.getByTestId("provider-list").textContent).toMatch(
        /-edited/,
      ),
    );

    fireEvent.click(screen.getByText("switch"));
    fireEvent.click(screen.getByText("duplicate"));
    await waitFor(() =>
      expect(screen.getByTestId("provider-list").textContent).toMatch(/copy/),
    );

    fireEvent.click(screen.getByText("open-website"));

    emitTauriEvent("provider-switched", {
      appType: "codex",
      providerId: "codex-2",
    });

    expect(toastErrorMock).not.toHaveBeenCalled();
    expect(toastSuccessMock).toHaveBeenCalled();
  }, 10_000);

  it("refreshes the route pointer when the proxy fails over to another provider", async () => {
    let routeProviderId = "claude-1";
    let modeRequests = 0;
    server.use(
      http.post("http://tauri.local/get_app_mode", async ({ request }) => {
        const { appType } = (await request.json()) as { appType: string };
        if (appType !== "claude") return;
        modeRequests += 1;
        return HttpResponse.json({
          mode: "route",
          attached: true,
          routeProviderId,
          directProviderId: "claude-1",
        });
      }),
    );

    const { default: App } = await import("@/App");
    renderApp(App);

    await waitFor(() => expect(modeRequests).toBeGreaterThan(0));
    const before = modeRequests;

    // 故障转移只改后端的路由指针，再发 provider-switched
    routeProviderId = "claude-2";
    emitTauriEvent("provider-switched", {
      appType: "claude",
      providerId: "claude-2",
      source: "failover",
    });

    await waitFor(() => expect(modeRequests).toBeGreaterThan(before));
  });

  it("resets provider view scroll when switching apps", async () => {
    const { default: App } = await import("@/App");
    const { container } = renderApp(App);

    await waitFor(() =>
      expect(screen.getByTestId("provider-list").textContent).toContain(
        "claude-1",
      ),
    );

    const mainScrollContainer = container.querySelector("main") as HTMLElement;
    // 列表的滚动区在模式行下面（切换式应用每个应用一份）
    const providerScrollContainer = () =>
      container.querySelector<HTMLElement>("#main-content");

    expect(mainScrollContainer).not.toBeNull();
    expect(providerScrollContainer()).not.toBeNull();

    mainScrollContainer.scrollTop = 320;
    mainScrollContainer.scrollLeft = 12;
    providerScrollContainer()!.scrollTop = 640;
    providerScrollContainer()!.scrollLeft = 24;

    fireEvent.click(sidebarApp("Codex"));

    await waitFor(() =>
      expect(screen.getByTestId("provider-list").textContent).toContain(
        "codex-1",
      ),
    );

    expect(mainScrollContainer.scrollTop).toBe(0);
    expect(mainScrollContainer.scrollLeft).toBe(0);
    expect(providerScrollContainer()!.scrollTop).toBe(0);
    expect(providerScrollContainer()!.scrollLeft).toBe(0);
  }, 10_000);

  it("closes provider panels when navigating away from the app page", async () => {
    const { default: App } = await import("@/App");
    renderApp(App);

    await waitFor(() =>
      expect(screen.getByTestId("provider-list").textContent).toContain(
        "claude-1",
      ),
    );

    // 面板只盖住内容区，侧栏还能点：切应用时编辑面板必须关掉，否则 Claude 的
    // 供应商会以 appId=codex 保存进 Codex
    fireEvent.click(screen.getByText("edit"));
    expect(screen.getByTestId("edit-provider-dialog")).toBeInTheDocument();
    fireEvent.click(sidebarApp("Codex"));
    await waitFor(() =>
      expect(screen.getByTestId("provider-list").textContent).toContain(
        "codex-1",
      ),
    );
    expect(
      screen.queryByTestId("edit-provider-dialog"),
    ).not.toBeInTheDocument();

    fireEvent.click(screen.getByText("usage"));
    expect(screen.getByTestId("usage-modal")).toBeInTheDocument();
    fireEvent.click(sidebarApp("nav.usage"));
    await waitFor(() =>
      expect(screen.queryByTestId("usage-modal")).not.toBeInTheDocument(),
    );

    fireEvent.click(sidebarApp("Codex"));
    await waitFor(() =>
      expect(screen.getByTestId("provider-list").textContent).toContain(
        "codex-1",
      ),
    );
    fireEvent.click(screen.getByText("create"));
    expect(screen.getByTestId("add-provider-dialog")).toBeInTheDocument();
    fireEvent.keyDown(window, { key: ",", metaKey: true });
    expect(await screen.findByTestId("settings-page")).toBeInTheDocument();
    expect(screen.queryByTestId("add-provider-dialog")).not.toBeInTheDocument();
  }, 10_000);

  it("asks before leaving an editor page with unsaved changes", async () => {
    const { default: App } = await import("@/App");
    renderApp(App);
    await waitFor(() =>
      expect(screen.getByTestId("provider-list").textContent).toContain(
        "claude-1",
      ),
    );

    // 没改过：照常离开，不问
    fireEvent.click(screen.getByText("edit"));
    fireEvent.click(sidebarApp("Codex"));
    await waitFor(() =>
      expect(screen.getByTestId("provider-list").textContent).toContain(
        "codex-1",
      ),
    );
    expect(screen.queryByTestId("confirm-dialog")).not.toBeInTheDocument();

    // 改过：先问；继续编辑就留在原页
    // （ConfirmDialog 在这个文件里是 mock：只渲染消息和 confirm-delete / cancel-delete）
    fireEvent.click(screen.getByText("edit"));
    fireEvent.input(screen.getByLabelText("edit-field"), {
      target: { value: "draft" },
    });
    fireEvent.click(sidebarApp("Claude Code"));
    expect(await screen.findByTestId("confirm-message")).toHaveTextContent(
      "common.unsavedLeaveMessage",
    );
    fireEvent.click(screen.getByText("cancel-delete"));
    expect(screen.getByTestId("edit-provider-dialog")).toBeInTheDocument();
    expect(screen.getByTestId("provider-list").textContent).toContain(
      "codex-1",
    );

    // ⌘, 也问；放弃后才离开
    fireEvent.keyDown(window, { key: ",", metaKey: true });
    expect(await screen.findByTestId("confirm-message")).toHaveTextContent(
      "common.unsavedLeaveMessage",
    );
    fireEvent.click(screen.getByText("confirm-delete"));
    expect(await screen.findByTestId("settings-page")).toBeInTheDocument();
    expect(
      screen.queryByTestId("edit-provider-dialog"),
    ).not.toBeInTheDocument();
  }, 10_000);

  it("keeps the unsaved guard when re-clicking the current page", async () => {
    const { default: App } = await import("@/App");
    renderApp(App);
    await waitFor(() =>
      expect(screen.getByTestId("provider-list").textContent).toContain(
        "claude-1",
      ),
    );

    fireEvent.click(sidebarApp("MCP"));
    fireEvent.input(await screen.findByLabelText("mcp-field"), {
      target: { value: "draft" },
    });

    // 再点当前页：不离开，所以不问，也不能把未保存登记清掉
    fireEvent.click(sidebarApp("MCP"));
    expect(screen.queryByTestId("confirm-dialog")).not.toBeInTheDocument();
    expect(screen.getByTestId("mcp-editor")).toBeInTheDocument();

    // 之后真的离开时照样要问
    fireEvent.click(sidebarApp("nav.usage"));
    expect(await screen.findByTestId("confirm-message")).toHaveTextContent(
      "common.unsavedLeaveMessage",
    );
    fireEvent.click(screen.getByText("cancel-delete"));
    expect(screen.getByTestId("mcp-editor")).toBeInTheDocument();
  }, 10_000);

  it("shows toast when auto sync fails in background", async () => {
    const { default: App } = await import("@/App");
    renderApp(App);

    await waitFor(() =>
      expect(screen.getByTestId("provider-list").textContent).toContain(
        "claude-1",
      ),
    );

    expect(() => {
      emitTauriEvent("webdav-sync-status-updated", null);
    }).not.toThrow();
    expect(toastErrorMock).not.toHaveBeenCalled();

    emitTauriEvent("webdav-sync-status-updated", {
      source: "auto",
      status: "error",
      error: "network timeout",
    });

    await waitFor(() => {
      expect(toastErrorMock).toHaveBeenCalled();
    });

    toastErrorMock.mockReset();
    expect(() => {
      emitTauriEvent("s3-sync-status-updated", null);
    }).not.toThrow();
    expect(toastErrorMock).not.toHaveBeenCalled();

    emitTauriEvent("s3-sync-status-updated", {
      source: "auto",
      status: "error",
      error: "s3 timeout",
    });

    await waitFor(() => {
      expect(toastErrorMock).toHaveBeenCalled();
    });
  });

  it("duplicates openclaw providers with a generated key that avoids live-only ids", async () => {
    setProviders("openclaw", {
      deepseek: {
        id: "deepseek",
        name: "DeepSeek",
        settingsConfig: {
          baseUrl: "https://api.deepseek.com",
          apiKey: "test-key",
          api: "openai-completions",
          models: [],
        },
        category: "custom",
        sortIndex: 0,
        createdAt: Date.now(),
      },
    });
    setCurrentProviderId("openclaw", "deepseek");
    setLiveProviderIds("openclaw", ["deepseek-copy"]);

    const { default: App } = await import("@/App");
    renderApp(App);

    fireEvent.click(sidebarApp("OpenClaw"));

    await waitFor(() =>
      expect(screen.getByTestId("provider-list").textContent).toContain(
        "deepseek",
      ),
    );

    fireEvent.click(screen.getByText("duplicate"));

    await waitFor(() => {
      const providerList = screen.getByTestId("provider-list").textContent;
      expect(providerList).toContain("deepseek-copy-2");
      expect(providerList).toContain("DeepSeek copy");
    });

    expect(toastErrorMock).not.toHaveBeenCalledWith(
      expect.stringContaining("Provider key is required for openclaw"),
    );
  });

  it.each([
    { options: { apiKey: "test-key" } },
    { npm: "@ai-sdk/openai-compatible", models: {} },
    { models: { "glm-5": { name: "GLM 5" } } },
  ])(
    "blocks incomplete OpenCode copies before saving or sorting: %j",
    async (settingsConfig) => {
      localStorage.setItem("cc-switch-last-app", "opencode");
      setProviders("opencode", {
        "opencode-go": {
          id: "opencode-go",
          name: "OpenCode Go",
          settingsConfig,
          sortIndex: 0,
        },
        other: { id: "other", name: "Other", settingsConfig: {}, sortIndex: 1 },
      });
      setCurrentProviderId("opencode", "opencode-go");
      setLiveProviderIds("opencode", ["opencode-go"]);
      const add = vi.spyOn(providersApi, "add");
      const sort = vi.spyOn(providersApi, "updateSortOrder");
      try {
        const { default: App } = await import("@/App");
        renderApp(App);
        await waitFor(() =>
          expect(screen.getByTestId("provider-list").textContent).toContain(
            "opencode-go",
          ),
        );
        fireEvent.click(screen.getByText("duplicate"));
        await waitFor(() =>
          expect(toastErrorMock).toHaveBeenCalledWith(
            "opencode.duplicateRequiresDefinition",
          ),
        );
        expect(add).not.toHaveBeenCalled();
        expect(sort).not.toHaveBeenCalled();
        expect(screen.getByTestId("provider-list").textContent).not.toContain(
          "opencode-go-copy",
        );
      } finally {
        add.mockRestore();
        sort.mockRestore();
      }
    },
  );

  it("duplicates complete OpenCode providers using an unused ID", async () => {
    localStorage.setItem("cc-switch-last-app", "opencode");
    setProviders("opencode", {
      custom: {
        id: "custom",
        name: "Custom",
        sortIndex: 0,
        settingsConfig: {
          npm: "@ai-sdk/openai-compatible",
          models: { "glm-5": { name: "GLM 5" } },
        },
      },
    });
    setCurrentProviderId("opencode", "custom");
    setLiveProviderIds("opencode", ["custom-copy"]);
    const { default: App } = await import("@/App");
    renderApp(App);
    await waitFor(() =>
      expect(screen.getByTestId("provider-list").textContent).toContain(
        "custom",
      ),
    );
    fireEvent.click(screen.getByText("duplicate"));
    await waitFor(() =>
      expect(screen.getByTestId("provider-list").textContent).toContain(
        "custom-copy-2",
      ),
    );
    expect(toastErrorMock).not.toHaveBeenCalled();
  });

  it.each([
    { settingsConfig: { settings: { baseURL: "https://native.example" } } },
    {
      settingsConfig: { models: { "glm-5": { name: "GLM 5" } } },
      meta: { opencodeConfigFormat: "v2" as const },
    },
  ])(
    "blocks incomplete native OpenCode copies with a V2 message: %j",
    async ({ settingsConfig, meta }) => {
      localStorage.setItem("cc-switch-last-app", "opencode");
      setProviders("opencode", {
        native: {
          id: "native",
          name: "Native",
          settingsConfig,
          meta,
          sortIndex: 0,
        },
      });
      setCurrentProviderId("opencode", "native");
      setLiveProviderIds("opencode", ["native"]);
      const add = vi.spyOn(providersApi, "add");
      try {
        const { default: App } = await import("@/App");
        renderApp(App);
        await waitFor(() =>
          expect(screen.getByTestId("provider-list").textContent).toContain(
            "native",
          ),
        );
        fireEvent.click(screen.getByText("duplicate"));
        await waitFor(() =>
          expect(toastErrorMock).toHaveBeenCalledWith(
            "opencode.duplicateRequiresNativeDefinition",
          ),
        );
        expect(add).not.toHaveBeenCalled();
      } finally {
        add.mockRestore();
      }
    },
  );

  it("duplicates complete native OpenCode providers using an unused ID", async () => {
    localStorage.setItem("cc-switch-last-app", "opencode");
    setProviders("opencode", {
      native: {
        id: "native",
        name: "Native",
        sortIndex: 0,
        settingsConfig: {
          package: "@opencode/ai/providers/openai",
          models: { "gpt-5": { name: "GPT 5" } },
        },
        meta: { opencodeConfigFormat: "v2" },
      },
    });
    setCurrentProviderId("opencode", "native");
    setLiveProviderIds("opencode", ["native-copy"]);
    const { default: App } = await import("@/App");
    renderApp(App);
    await waitFor(() =>
      expect(screen.getByTestId("provider-list").textContent).toContain(
        "native",
      ),
    );
    fireEvent.click(screen.getByText("duplicate"));
    await waitFor(() =>
      expect(screen.getByTestId("provider-list").textContent).toContain(
        "native-copy-2",
      ),
    );
    expect(toastErrorMock).not.toHaveBeenCalled();
  });

  it("duplicates MiniMax Code providers under a generated unused key", async () => {
    localStorage.setItem("cc-switch-last-app", "mcode");
    const provider = (id: string, name: string) => ({
      id,
      name,
      settingsConfig: {},
      category: "custom" as const,
      sortIndex: 0,
      createdAt: Date.now(),
    });
    setProviders("mcode", {
      kimi: provider("kimi", "Kimi"),
      "kimi-copy": provider("kimi-copy", "Kimi copy"),
    });
    setCurrentProviderId("mcode", "kimi");

    const { default: App } = await import("@/App");
    renderApp(App);

    await waitFor(() =>
      expect(screen.getByTestId("provider-list").textContent).toContain(
        "kimi-copy",
      ),
    );
    fireEvent.click(screen.getByText("duplicate"));

    await waitFor(() =>
      expect(screen.getByTestId("provider-list").textContent).toContain(
        "kimi-copy-2",
      ),
    );
    expect(toastErrorMock).not.toHaveBeenCalledWith(
      expect.stringContaining("Provider key is required for mcode"),
    );
  });

  it("refreshes MiniMax Code provider membership after removing it from live config", async () => {
    localStorage.setItem("cc-switch-last-app", "mcode");
    let liveConfigManaged = true;
    let providerRequests = 0;
    server.use(
      http.post("http://tauri.local/get_providers", async ({ request }) => {
        const { app } = (await request.json()) as { app: string };
        if (app !== "mcode") return;
        providerRequests += 1;
        return HttpResponse.json({
          custom: {
            id: "custom",
            name: "Custom MiniMax Code",
            settingsConfig: {},
            meta: { liveConfigManaged },
          },
        });
      }),
      http.post(
        "http://tauri.local/remove_provider_from_live_config",
        async ({ request }) => {
          expect(await request.json()).toEqual({ id: "custom", app: "mcode" });
          liveConfigManaged = false;
          return HttpResponse.json(true);
        },
      ),
    );

    const { default: App } = await import("@/App");
    renderApp(App);

    await waitFor(() =>
      expect(screen.getByTestId("provider-list")).toHaveTextContent(
        '"liveConfigManaged":true',
      ),
    );
    const requestsBeforeRemoval = providerRequests;
    fireEvent.click(screen.getByText("remove"));
    fireEvent.click(screen.getByText("confirm-delete"));

    await waitFor(() =>
      expect(screen.queryByTestId("confirm-dialog")).not.toBeInTheDocument(),
    );
    expect(liveConfigManaged).toBe(false);
    await waitFor(() =>
      expect(screen.getByTestId("provider-list")).toHaveTextContent(
        '"liveConfigManaged":false',
      ),
    );
    expect(providerRequests).toBeGreaterThan(requestsBeforeRemoval);
    expect(screen.getByTestId("provider-list")).toHaveTextContent(
      "Custom MiniMax Code",
    );
  });

  it("rereads Kimi's default after a removal is refused for a stale default", async () => {
    localStorage.setItem("cc-switch-last-app", "kimi");
    let kimiCurrent = "kimi-sub";
    let currentRequests = 0;
    server.use(
      http.post("http://tauri.local/get_providers", async ({ request }) => {
        const { app } = (await request.json()) as { app: string };
        if (app !== "kimi") return;
        return HttpResponse.json({
          go: {
            id: "go",
            name: "OpenCode Go",
            settingsConfig: {},
            meta: { liveConfigManaged: true },
          },
          "kimi-sub": {
            id: "kimi-sub",
            name: "Kimi subscription",
            settingsConfig: {},
            meta: { liveConfigManaged: true },
          },
        });
      }),
      http.post(
        "http://tauri.local/get_current_provider",
        async ({ request }) => {
          const { app } = (await request.json()) as { app: string };
          if (app !== "kimi") return;
          currentRequests += 1;
          return HttpResponse.json(kimiCurrent);
        },
      ),
      http.post("http://tauri.local/remove_provider_from_live_config", () =>
        HttpResponse.json(
          "无效输入: Select another default model in Kimi Code before removing this model or provider",
          { status: 500 },
        ),
      ),
    );

    const { default: App } = await import("@/App");
    renderApp(App);

    await waitFor(() =>
      expect(screen.getByTestId("current-provider")).toHaveTextContent(
        "kimi-sub",
      ),
    );
    // 用户在 Kimi Code 里用 /model 换到了 OpenCode Go 的模型，页面还没重读
    kimiCurrent = "go";
    const requestsBeforeRemoval = currentRequests;
    fireEvent.click(screen.getByText("remove"));
    fireEvent.click(screen.getByText("confirm-delete"));

    await waitFor(() =>
      expect(toastErrorMock).toHaveBeenCalledWith(
        "notifications.removeFromConfigFailed",
        expect.objectContaining({
          description: "kimi.error.defaultModelInUse",
        }),
      ),
    );
    await waitFor(() =>
      expect(screen.getByTestId("current-provider")).toHaveTextContent("go"),
    );
    expect(currentRequests).toBeGreaterThan(requestsBeforeRemoval);
  });

  it("warns without blocking when removing Pi's global default provider", async () => {
    localStorage.setItem("cc-switch-last-app", "pi");
    setProviders("pi", {
      custom: {
        id: "custom",
        name: "Custom Pi",
        settingsConfig: {
          baseUrl: "https://api.example.com/v1",
          apiKey: "test-key",
          api: "openai-completions",
          models: [{ id: "model-a" }],
        },
        category: "custom",
        sortIndex: 0,
        createdAt: Date.now(),
      },
    });
    server.use(
      http.post("http://tauri.local/get_pi_current_state", () =>
        HttpResponse.json({
          enabledProviderIds: ["custom"],
          defaultProviderId: "custom",
        }),
      ),
    );

    const { default: App } = await import("@/App");
    renderApp(App);

    await waitFor(() =>
      expect(screen.getByTestId("provider-list").textContent).toContain(
        "Custom Pi",
      ),
    );
    fireEvent.click(screen.getByText("remove"));

    expect(screen.getByTestId("confirm-message")).toHaveTextContent(
      "confirm.piDefaultProviderWarning",
    );
    fireEvent.click(screen.getByText("confirm-delete"));
    await waitFor(() =>
      expect(screen.queryByTestId("confirm-dialog")).not.toBeInTheDocument(),
    );
  });

  it("shows toast when duplicate cannot load live provider ids", async () => {
    setProviders("openclaw", {
      deepseek: {
        id: "deepseek",
        name: "DeepSeek",
        settingsConfig: {
          baseUrl: "https://api.deepseek.com",
          apiKey: "test-key",
          api: "openai-completions",
          models: [],
        },
        category: "custom",
        sortIndex: 0,
        createdAt: Date.now(),
      },
    });
    setCurrentProviderId("openclaw", "deepseek");

    const liveIdsSpy = vi
      .spyOn(providersApi, "getOpenClawLiveProviderIds")
      .mockRejectedValueOnce(new Error("broken config"));

    const { default: App } = await import("@/App");
    renderApp(App);

    fireEvent.click(sidebarApp("OpenClaw"));

    await waitFor(() =>
      expect(screen.getByTestId("provider-list").textContent).toContain(
        "deepseek",
      ),
    );

    fireEvent.click(screen.getByText("duplicate"));

    await waitFor(() => {
      expect(toastErrorMock).toHaveBeenCalledWith(
        expect.stringContaining("读取配置中的供应商标识失败"),
      );
    });

    expect(screen.getByTestId("provider-list").textContent).not.toContain(
      "deepseek-copy",
    );

    liveIdsSpy.mockRestore();
  });

  it("wires remote OpenClaw default model actions through the provider list", async () => {
    setRemoteProfiles([
      {
        id: "remote-1",
        name: "Remote 1",
        host: "192.168.1.20",
        port: 22,
        username: "root",
        authMethod: { type: "sshAgent" },
        helperPath: "~/.local/bin/cc-switch-remote-helper",
        createdAt: 1,
        updatedAt: 1,
      },
    ]);
    setProviders("openclaw", {
      deepseek: {
        id: "deepseek",
        name: "DeepSeek",
        settingsConfig: {
          baseUrl: "https://api.deepseek.com",
          apiKey: "test-key",
          api: "openai-completions",
          models: [{ id: "deepseek-chat" }, { id: "deepseek-reasoner" }],
        },
        category: "custom",
        sortIndex: 0,
        createdAt: Date.now(),
      },
    });
    setCurrentProviderId("openclaw", "deepseek");

    const { default: App } = await import("@/App");
    renderApp(App);

    fireEvent.click(sidebarApp("OpenClaw"));
    await waitFor(() =>
      expect(screen.getByTestId("provider-list").textContent).toContain(
        "deepseek",
      ),
    );

    fireEvent.click(await screen.findByText("Remote 1"));
    await waitFor(() =>
      expect(screen.getByTestId("provider-list").textContent).toContain(
        "deepseek",
      ),
    );
    expect(screen.getByTestId("provider-target")).toHaveTextContent("remote");

    fireEvent.click(screen.getByText("set-default"));

    await waitFor(() => {
      expect(getRemoteOpenClawDefaultModel()).toEqual({
        primary: "deepseek/deepseek-chat",
      });
    });
  }, 20_000);

  it("uses the stored backend password when activating a password remote target", async () => {
    setRemoteProfiles([
      {
        id: "remote-1",
        name: "Remote 1",
        host: "192.168.1.20",
        port: 22,
        username: "root",
        authMethod: { type: "password" },
        helperPath: "~/.local/bin/cc-switch-remote-helper",
        createdAt: 1,
        updatedAt: 1,
      },
    ]);

    const { default: App } = await import("@/App");
    renderApp(App);

    await waitFor(() =>
      expect(screen.getByTestId("provider-target")).toHaveTextContent("local"),
    );

    fireEvent.click(await screen.findByText("Remote 1"));

    await waitFor(() =>
      expect(screen.getByTestId("provider-target")).toHaveTextContent("remote"),
    );
    expect(
      screen.queryByTestId("remote-session-password-dialog"),
    ).not.toBeInTheDocument();
    expect(getLastRemoteSaveSecret()).toBeNull();
  });

  it("prompts and persists a password when the remote backend reports it missing", async () => {
    setRemoteProfiles([
      {
        id: "remote-1",
        name: "Remote 1",
        host: "192.168.1.20",
        port: 22,
        username: "root",
        authMethod: { type: "password" },
        helperPath: "~/.local/bin/cc-switch-remote-helper",
        createdAt: 1,
        updatedAt: 1,
      },
    ]);
    setRemoteProviderStateError("Remote SSH password is required");

    const { default: App } = await import("@/App");
    renderApp(App);

    await waitFor(() =>
      expect(screen.getByTestId("provider-target")).toHaveTextContent("local"),
    );

    fireEvent.click(await screen.findByText("Remote 1"));

    expect(
      await screen.findByTestId("remote-session-password-dialog"),
    ).toBeInTheDocument();
    expect(screen.getByTestId("management-target-switcher")).toHaveAttribute(
      "data-active-target-key",
      "remote:remote-1",
    );
    expect(screen.getByTestId("provider-target")).toHaveTextContent("remote");

    fireEvent.change(screen.getByTestId("remote-session-password-input"), {
      target: { value: "secret-password" },
    });
    setRemoteProviderStateError(null);
    fireEvent.click(screen.getByTestId("remote-session-password-confirm"));

    await waitFor(() =>
      expect(screen.getByTestId("provider-target")).toHaveTextContent("remote"),
    );
    expect(getLastRemoteSaveSecret()).toEqual({
      password: "secret-password",
    });
  });

  it("keeps the user on remote server management after saving a profile", async () => {
    localStorage.setItem("cc-switch-last-view", "providers");
    setSettings({ firstRunNoticeConfirmed: true });
    setRemoteProfiles([]);

    const { default: App } = await import("@/App");
    renderApp(App);

    // v4 里入口在侧栏的目标菜单：管理远程主机
    fireEvent.click(screen.getByText("manage-servers"));
    await waitFor(() =>
      expect(
        screen.getByTestId("remote-server-list-panel"),
      ).toBeInTheDocument(),
    );

    fireEvent.click(screen.getAllByRole("button", { name: "新增服务器" })[0]);
    fireEvent.change(screen.getByLabelText("名称"), {
      target: { value: "测试服务器" },
    });
    fireEvent.change(screen.getByPlaceholderText("10.0.0.10"), {
      target: { value: "192.0.2.10" },
    });
    fireEvent.change(screen.getByPlaceholderText("deploy"), {
      target: { value: "root" },
    });
    fireEvent.click(screen.getByRole("button", { name: "保存" }));

    await waitFor(() => expect(toastSuccessMock).toHaveBeenCalled());
    // 保存后仍停在连接管理页，不会被顺手带到供应商页
    expect(screen.getByTestId("remote-server-list-panel")).toBeInTheDocument();
    expect(screen.getAllByText("测试服务器").length).toBeGreaterThan(0);
    expect(localStorage.getItem("cc-switch-last-view")).toBe("remoteServers");
    expect(screen.queryByTestId("provider-target")).not.toBeInTheDocument();
  }, 20_000);

  it("does not refresh the local tray after remote import success", async () => {
    const updateTrayMenuSpy = vi
      .spyOn(providersApi, "updateTrayMenu")
      .mockResolvedValue(true);
    setRemoteProfiles([
      {
        id: "remote-1",
        name: "Remote 1",
        host: "192.168.1.20",
        port: 22,
        username: "root",
        authMethod: { type: "sshAgent" },
        helperPath: "~/.local/bin/cc-switch-remote-helper",
        createdAt: 1,
        updatedAt: 1,
      },
    ]);

    const { default: App } = await import("@/App");
    renderApp(App);

    fireEvent.click(await screen.findByText("Remote 1"));
    fireEvent.click(navButton("nav.settings"));
    await waitFor(() =>
      expect(screen.getByTestId("settings-target")).toHaveTextContent("remote"),
    );
    expect(
      screen.getByTestId("management-target-switcher"),
    ).toBeInTheDocument();

    fireEvent.click(screen.getByText("simulate-import-success"));

    await waitFor(() =>
      expect(screen.getByTestId("settings-page")).toBeInTheDocument(),
    );
    expect(updateTrayMenuSpy).not.toHaveBeenCalled();
    updateTrayMenuSpy.mockRestore();
  }, 20_000);

  it("refreshes remote providers after remote universal provider sync without touching the local tray", async () => {
    const updateTrayMenuSpy = vi
      .spyOn(providersApi, "updateTrayMenu")
      .mockResolvedValue(true);
    setRemoteProfiles([
      {
        id: "remote-1",
        name: "Remote 1",
        host: "192.168.1.20",
        port: 22,
        username: "root",
        authMethod: { type: "sshAgent" },
        helperPath: "~/.local/bin/cc-switch-remote-helper",
        createdAt: 1,
        updatedAt: 1,
      },
    ]);

    const { default: App } = await import("@/App");
    renderApp(App);

    fireEvent.click(await screen.findByText("Remote 1"));
    await waitFor(() =>
      expect(screen.getByTestId("provider-target")).toHaveTextContent("remote"),
    );
    expect(screen.getByTestId("provider-list").textContent).not.toContain(
      "Remote Synced",
    );

    setProviders("claude", {
      "claude-1": {
        id: "claude-1",
        name: "Claude Default",
        settingsConfig: {},
        category: "official",
        sortIndex: 0,
        createdAt: 1,
      },
      "remote-synced": {
        id: "remote-synced",
        name: "Remote Synced",
        settingsConfig: {},
        category: "custom",
        sortIndex: 1,
        createdAt: 2,
      },
    });

    emitTauriEvent("remote-universal-provider-synced", {
      action: "sync",
      id: "universal-1",
    });

    await waitFor(() =>
      expect(screen.getByTestId("provider-list").textContent).toContain(
        "Remote Synced",
      ),
    );
    expect(updateTrayMenuSpy).not.toHaveBeenCalled();
    updateTrayMenuSpy.mockRestore();
  }, 20_000);

  it("opens the local About settings from the update badge while managing a remote target", async () => {
    localStorage.setItem("cc-switch-last-view", "providers");
    setSettings({ firstRunNoticeConfirmed: true });
    updateMocks.hasUpdate = true;
    setRemoteProfiles([
      {
        id: "remote-1",
        name: "Remote 1",
        host: "192.168.1.20",
        port: 22,
        username: "root",
        authMethod: { type: "sshAgent" },
        helperPath: "/root/.local/bin/cc-switch-remote-helper",
        createdAt: 1,
        updatedAt: 1,
      },
    ]);

    const { default: App } = await import("@/App");
    renderApp(App);

    fireEvent.click(await screen.findByText("Remote 1"));
    await waitFor(() =>
      expect(screen.getByTestId("provider-target")).toHaveTextContent("remote"),
    );

    // 侧栏「设置」带客户端更新徽标：点它进本机设置的「关于」，
    // 而不是那台远端主机的设置页
    fireEvent.click(navButton("nav.settings"));

    await waitFor(() =>
      expect(screen.getByTestId("settings-target")).toHaveTextContent("local"),
    );
    expect(screen.getByTestId("settings-default-tab")).toHaveTextContent(
      "about",
    );
  }, 20_000);

  it("uses per-host remote app visibility while managing a remote target", async () => {
    localStorage.setItem("cc-switch-last-app", "claude");
    localStorage.setItem("cc-switch-last-view", "providers");
    setSettings({ firstRunNoticeConfirmed: true });
    setRemoteSettings({
      visibleApps: {
        claude: true,
        "claude-desktop": false,
        codex: true,
        gemini: false,
        grokbuild: false,
        opencode: false,
        openclaw: false,
        hermes: false,
        mcode: false,
        kimi: false,
        agy: false,
        omp: false,
        pi: false,
      },
    });
    setRemoteProfiles([
      {
        id: "remote-1",
        name: "Remote 1",
        host: "192.168.1.20",
        port: 22,
        username: "root",
        authMethod: { type: "sshAgent" },
        helperPath: "~/.local/bin/cc-switch-remote-helper",
        createdAt: 1,
        updatedAt: 1,
      },
    ]);

    const { default: App } = await import("@/App");
    renderApp(App);

    // 本机目标：Gemini 可见
    expect(querySidebarApp("Gemini CLI")).toBeInTheDocument();

    fireEvent.click(await screen.findByText("Remote 1"));

    // 远端目标：用那台主机的可见应用列表；当前应用被隐藏时回落到可见的 Codex
    await waitFor(() =>
      expect(querySidebarApp("Gemini CLI")).not.toBeInTheDocument(),
    );
    expect(sidebarApp("Codex")).toBeInTheDocument();
    await waitFor(() =>
      expect(screen.getByTestId("provider-target")).toHaveTextContent("remote"),
    );
  }, 20_000);

  it("updates remote app visibility immediately after remote settings save", async () => {
    localStorage.setItem("cc-switch-last-app", "codex");
    localStorage.setItem("cc-switch-last-view", "providers");
    setSettings({ firstRunNoticeConfirmed: true });
    setRemoteSettings({
      visibleApps: {
        claude: true,
        "claude-desktop": false,
        codex: true,
        gemini: false,
        grokbuild: false,
        opencode: false,
        openclaw: false,
        hermes: false,
        mcode: false,
        kimi: false,
        agy: false,
        omp: false,
        pi: false,
      },
    });
    setRemoteProfiles([
      {
        id: "remote-1",
        name: "Remote 1",
        host: "192.168.1.20",
        port: 22,
        username: "root",
        authMethod: { type: "sshAgent" },
        helperPath: "~/.local/bin/cc-switch-remote-helper",
        createdAt: 1,
        updatedAt: 1,
      },
    ]);

    const { default: App } = await import("@/App");
    renderApp(App);

    fireEvent.click(await screen.findByText("Remote 1"));
    await waitFor(() =>
      expect(screen.getByTestId("provider-target")).toHaveTextContent("remote"),
    );

    fireEvent.click(navButton("nav.settings"));
    await waitFor(() =>
      expect(screen.getByTestId("settings-target")).toHaveTextContent("remote"),
    );

    // 远端设置保存后立刻换掉可见应用：不用重连也不用刷新
    fireEvent.click(screen.getByText("simulate-remote-settings-saved"));
    fireEvent.click(screen.getByText("close-settings"));

    await waitFor(() =>
      expect(querySidebarApp("Gemini CLI")).toBeInTheDocument(),
    );
    expect(querySidebarApp("Claude Code")).not.toBeInTheDocument();
    expect(sidebarApp("Gemini CLI")).toBeInTheDocument();
  }, 20_000);

  it("hides homepage routing controls while managing a remote target until remote settings enable them", async () => {
    localStorage.setItem("cc-switch-last-app", "claude");
    localStorage.setItem("cc-switch-last-view", "providers");
    setSettings({ firstRunNoticeConfirmed: true });
    setRemoteProfiles([
      {
        id: "remote-1",
        name: "Remote 1",
        host: "192.168.1.20",
        port: 22,
        username: "root",
        authMethod: { type: "sshAgent" },
        helperPath: "~/.local/bin/cc-switch-remote-helper",
        createdAt: 1,
        updatedAt: 1,
      },
    ]);

    const { default: App } = await import("@/App");
    renderApp(App);

    // 本机目标：本机路由/故障转移控件在，会话页入口也在
    expect(navButton("nav.sessions")).toBeInTheDocument();

    fireEvent.click(await screen.findByText("Remote 1"));
    await waitFor(() =>
      expect(screen.getByTestId("provider-target")).toHaveTextContent("remote"),
    );

    // 远端目标：本机路由控件不出现；远端开关未开启时也不出现；
    // 会话页入口仍可用（远端会话列表是支持的）
    expect(screen.queryByTestId("proxy-toggle")).not.toBeInTheDocument();
    expect(
      screen.queryByTestId("remote-routing-toggle"),
    ).not.toBeInTheDocument();
    expect(
      screen.queryByTestId("remote-app-routing-toggle"),
    ).not.toBeInTheDocument();
    expect(navButton("nav.sessions")).toBeInTheDocument();
  }, 20_000);

  it("shows only remote app routing and failover homepage controls when enabled per remote host", async () => {
    localStorage.setItem("cc-switch-last-app", "claude");
    localStorage.setItem("cc-switch-last-view", "providers");
    setSettings({ firstRunNoticeConfirmed: true });
    setRemoteSettings({
      enableRemoteRoutingToggle: true,
      visibleApps: {
        claude: true,
        "claude-desktop": true,
        codex: true,
        gemini: true,
        grokbuild: true,
        opencode: true,
        openclaw: true,
        hermes: true,
        pi: true,
        mcode: false,
        kimi: false,
        agy: false,
        omp: false,
      },
    });
    setRemoteProfiles([
      {
        id: "remote-1",
        name: "Remote 1",
        host: "192.168.1.20",
        port: 22,
        username: "root",
        authMethod: { type: "sshAgent" },
        helperPath: "~/.local/bin/cc-switch-remote-helper",
        createdAt: 1,
        updatedAt: 1,
      },
    ]);

    const { default: App } = await import("@/App");
    renderApp(App);

    fireEvent.click(await screen.findByText("Remote 1"));
    await waitFor(() =>
      expect(screen.getByTestId("provider-target")).toHaveTextContent("remote"),
    );

    await waitFor(() =>
      expect(
        screen.queryByTestId("remote-app-routing-toggle"),
      ).toBeInTheDocument(),
    );
    // 本机路由控件不出现；远端应用路由开关跟着当前应用走
    expect(screen.queryByTestId("proxy-toggle")).not.toBeInTheDocument();
    expect(
      screen.queryByTestId("remote-routing-toggle"),
    ).not.toBeInTheDocument();
    expect(screen.getByTestId("remote-app-routing-toggle")).toHaveTextContent(
      "claude",
    );

    fireEvent.click(sidebarApp("Grok Build"));
    await waitFor(() =>
      expect(screen.getByTestId("remote-app-routing-toggle")).toHaveTextContent(
        "grokbuild",
      ),
    );
  }, 20_000);

  it("opens remote session management without using local session data", async () => {
    localStorage.setItem("cc-switch-last-app", "codex");
    localStorage.setItem("cc-switch-last-view", "providers");
    setSettings({ firstRunNoticeConfirmed: true });
    // 本机记录里放一条同名不同题目的会话：远端目标下不能拿它顶替
    setSessionFixtures(
      [
        {
          providerId: "codex",
          sessionId: "local-codex-session",
          title: "Local Only Session",
          summary: "Local summary",
          projectDir: "/local/project",
          createdAt: 1,
          lastActiveAt: 2,
          sourcePath: "/local/codex/session.jsonl",
          resumeCommand: "codex resume local-codex-session",
        },
      ],
      {},
    );
    setRemoteProfiles([
      {
        id: "remote-1",
        name: "Remote 1",
        host: "192.168.1.20",
        port: 22,
        username: "root",
        authMethod: { type: "sshAgent" },
        helperPath: "/root/.local/bin/cc-switch-remote-helper",
        createdAt: 1,
        updatedAt: 1,
      },
    ]);

    const { default: App } = await import("@/App");
    renderApp(App);

    expect(screen.getByTestId("provider-target")).toHaveTextContent("local");

    fireEvent.click(await screen.findByText("Remote 1"));
    await waitFor(() =>
      expect(screen.getByTestId("provider-target")).toHaveTextContent("remote"),
    );

    // 远端目标下会话页可以打开（页头由页面自己画；远端列表/正文由
    // SessionManagerPage.test.tsx 覆盖），但绝不能把本机会话当成远端数据
    fireEvent.click(navButton("nav.sessions"));
    await waitFor(() =>
      expect(screen.queryByText("Local Only Session")).not.toBeInTheDocument(),
    );
    expect(screen.queryByText("Local Only Session")).not.toBeInTheDocument();
  }, 20_000);

  it("keeps Hermes memory remote-capable while hiding local-only WebUI controls", async () => {
    localStorage.setItem("cc-switch-last-app", "hermes");
    localStorage.setItem("cc-switch-last-view", "providers");
    setSettings({ firstRunNoticeConfirmed: true });
    setRemoteProfiles([
      {
        id: "remote-1",
        name: "Remote 1",
        host: "192.168.1.20",
        port: 22,
        username: "root",
        authMethod: { type: "sshAgent" },
        helperPath: "/root/.local/bin/cc-switch-remote-helper",
        createdAt: 1,
        updatedAt: 1,
      },
    ]);

    const { default: App } = await import("@/App");
    renderApp(App);

    expect(screen.getByTestId("provider-target")).toHaveTextContent("local");

    // Hermes 页：供应商 / 记忆两个页签；本机目标下「打开配置」是本机专属入口
    const hermesTabs = await screen.findByRole("tablist", {
      name: "Hermes",
      hidden: true,
    });
    expect(
      within(hermesTabs)
        .getAllByRole("tab", { hidden: true })
        .map((tab) => tab.textContent),
    ).toEqual(["appPage.providers", "appPage.memory"]);

    fireEvent.click(await screen.findByText("Remote 1"));
    await waitFor(() =>
      expect(screen.getByTestId("provider-target")).toHaveTextContent("remote"),
    );

    // 远端目标：记忆页签仍在（读写在 HermesMemory*.test.tsx 覆盖），
    // 本机专属的「打开配置」入口不再出现
    const remoteTabs = await screen.findByRole("tablist", {
      name: "Hermes",
      hidden: true,
    });
    expect(
      within(remoteTabs).getAllByRole("tab", { hidden: true }),
    ).toHaveLength(2);
    expect(
      screen.queryByText("hermes.memory.openConfig"),
    ).not.toBeInTheDocument();
  }, 20_000);

  it("renders the Skills page with its own header", async () => {
    localStorage.setItem("cc-switch-last-view", "skills");
    const { default: App } = await import("@/App");
    renderApp(App);

    expect(await screen.findByTestId("unified-skills-panel")).toHaveTextContent(
      "installed",
    );
  });

  it("navigates OpenClaw and Hermes pages with underline tabs", async () => {
    const { default: App } = await import("@/App");
    renderApp(App);

    fireEvent.click(sidebarApp("OpenClaw"));
    // 首次启动提示是模态对话框，页面其余部分是 aria-hidden，所以带上 hidden
    const openclawTabs = await screen.findByRole("tablist", {
      name: "OpenClaw",
      hidden: true,
    });
    const pageTabs = within(openclawTabs).getAllByRole("tab", { hidden: true });
    expect(pageTabs.map((tab) => tab.textContent)).toEqual([
      "appPage.providers",
      "appPage.workspace",
      "appPage.openclawConfig",
    ]);
    expect(pageTabs[0]).toHaveAttribute("aria-selected", "true");
    expect(
      screen.queryByRole("group", { name: "OpenClaw", hidden: true }),
    ).not.toBeInTheDocument();

    fireEvent.click(pageTabs[2]);
    const configTabs = await screen.findByRole("tablist", {
      name: "appPage.openclawConfig",
      hidden: true,
    });
    const subTabs = within(configTabs).getAllByRole("tab", { hidden: true });
    expect(subTabs).toHaveLength(3);
    expect(subTabs[0]).toHaveAttribute("aria-selected", "true");
    expect(screen.getByRole("tabpanel", { hidden: true })).toHaveAttribute(
      "aria-labelledby",
      "openclaw-config-env",
    );

    fireEvent.click(sidebarApp("Hermes"));
    const hermesTabs = await screen.findByRole("tablist", {
      name: "Hermes",
      hidden: true,
    });
    const hermesPageTabs = within(hermesTabs).getAllByRole("tab", {
      hidden: true,
    });
    expect(hermesPageTabs.map((tab) => tab.textContent)).toEqual([
      "appPage.providers",
      "appPage.memory",
    ]);

    // 记忆页：页头的 solid 主操作换成「保存」，两份记忆用二级页签
    fireEvent.click(hermesPageTabs[1]);
    const header = document.querySelector("header") as HTMLElement;
    const save = await within(header).findByRole("button", {
      name: "common.save",
      hidden: true,
    });
    expect(save).toHaveAttribute("aria-disabled", "true");
    expect(
      within(header).queryByRole("button", {
        name: /provider.addProvider/,
        hidden: true,
      }),
    ).not.toBeInTheDocument();
    const memoryTabs = await screen.findByRole("tablist", {
      name: "hermes.memory.fileTabs",
      hidden: true,
    });
    expect(
      within(memoryTabs).getAllByRole("tab", { hidden: true }),
    ).toHaveLength(2);
    await waitFor(() =>
      expect(
        screen.getAllByRole("textbox", {
          name: "hermes.memory.editorLabel",
          hidden: true,
        })[0],
      ).toHaveValue("agent notes"),
    );
  });

  it("opens the old skillsDiscovery view as the Discover segment", async () => {
    localStorage.setItem("cc-switch-last-view", "skillsDiscovery");
    const { default: App } = await import("@/App");
    renderApp(App);

    expect(await screen.findByTestId("unified-skills-panel")).toHaveTextContent(
      "discover",
    );
  });

  it("shows all eight native resize cursors and restores existing inline styles", async () => {
    windowMocks.isLinux.mockReturnValue(true);
    setSettings({ useAppWindowControls: true });
    const { default: App } = await import("@/App");
    const { unmount } = renderApp(App);
    const header = document.querySelector("header")!;
    header.style.setProperty("cursor", "help", "important");
    const x = window.innerWidth;
    const y = window.innerHeight;

    await waitFor(() => {
      fireEvent.mouseMove(header, { clientX: x / 2, clientY: 1 });
      expect(header.style.cursor).toBe("ns-resize");
    });
    for (const [clientX, clientY, cursor] of [
      [x / 2, y - 1, "ns-resize"],
      [1, y / 2, "ew-resize"],
      [x - 1, y / 2, "ew-resize"],
      [1, 1, "nwse-resize"],
      [x - 1, y - 1, "nwse-resize"],
      [x - 1, 1, "nesw-resize"],
      [1, y - 1, "nesw-resize"],
    ] as const) {
      fireEvent.mouseMove(header, { clientX, clientY });
      expect(header.style.cursor).toBe(cursor);
      expect(header.style.getPropertyPriority("cursor")).toBe("important");
    }
    fireEvent.mouseMove(header, { clientX: x / 2, clientY: 30 });
    expect(header.style.cursor).toBe("help");
    expect(header.style.getPropertyPriority("cursor")).toBe("important");

    const icon = header.querySelector("svg")!;
    fireEvent.mouseMove(header, { clientX: x / 2, clientY: 1 });
    fireEvent.mouseMove(icon, { clientX: x / 2, clientY: 1 });
    expect(header.style.cursor).toBe("help");
    expect(icon.style.cursor).toBe("ns-resize");
    fireEvent.blur(window);
    expect(icon.style.cursor).toBe("");
    vi.stubGlobal("devicePixelRatio", 2);
    windowMocks.scaleFactor.mockResolvedValue(2);
    try {
      await act(async () => {
        windowMocks.resizeListeners.forEach((handler) => handler());
      });
      fireEvent.mouseMove(header, { clientX: x / 2, clientY: 9 });
      expect(header.style.cursor).toBe("ns-resize");
      fireEvent.mouseMove(header, { clientX: x / 2, clientY: 10 });
      expect(header.style.cursor).toBe("help");
      fireEvent.mouseMove(header, { clientX: x / 2, clientY: 1 });
      unmount();
    } finally {
      vi.unstubAllGlobals();
    }
    expect(header.style.cursor).toBe("help");
  });

  it("lets the top edge resize before Tauri dragging without blocking inner-header or button events", async () => {
    windowMocks.isLinux.mockReturnValue(true);
    setSettings({ useAppWindowControls: true });
    const { default: App } = await import("@/App");
    renderApp(App);
    const header = document.querySelector("header")!;
    await waitFor(() => {
      fireEvent.mouseMove(header, { clientX: 500, clientY: 1 });
      expect(header.style.cursor).toBe("ns-resize");
    });

    // Tauri's drag-region script listens during document bubbling.
    const startDragging = vi.fn();
    const documentMouseDown = vi.fn((event: MouseEvent) => {
      const drag = (event.target as Element).getAttribute(
        "data-tauri-drag-region",
      );
      if (
        drag !== null &&
        drag !== "false" &&
        event.button === 0 &&
        (event.detail === 1 || event.detail === 2)
      ) {
        startDragging();
      }
    });
    document.addEventListener("mousedown", documentMouseDown);
    try {
      for (const detail of [1, 2]) {
        const edgePress = new MouseEvent("mousedown", {
          bubbles: true,
          cancelable: true,
          button: 0,
          detail,
          clientX: 500,
          clientY: 1,
        });
        header.dispatchEvent(edgePress);
        expect(edgePress.defaultPrevented).toBe(false);
      }
      expect(documentMouseDown).not.toHaveBeenCalled();
      expect(startDragging).not.toHaveBeenCalled();
      fireEvent.mouseDown(header, {
        button: 0,
        detail: 1,
        clientX: 500,
        clientY: 30,
      });
      fireEvent.mouseDown(header, { button: 2, clientX: 500, clientY: 1 });
      fireEvent.mouseDown(header.querySelector("button")!, {
        button: 0,
        clientX: 500,
        clientY: 1,
      });
      expect(documentMouseDown).toHaveBeenCalledTimes(3);
      expect(startDragging).toHaveBeenCalledTimes(1);
    } finally {
      document.removeEventListener("mousedown", documentMouseDown);
    }
  });

  it("clears resize hints and leaves events alone when native resizing is unavailable", async () => {
    windowMocks.isLinux.mockReturnValue(true);
    setSettings({ useAppWindowControls: true });
    const { default: App } = await import("@/App");
    renderApp(App);
    const header = document.querySelector("header")!;
    const moveToEdge = () =>
      fireEvent.mouseMove(header, { clientX: 500, clientY: 1 });
    await waitFor(() => {
      moveToEdge();
      expect(header.style.cursor).toBe("ns-resize");
    });
    const documentMouseDown = vi.fn();
    document.addEventListener("mousedown", documentMouseDown);
    try {
      for (const [method, disabledValue] of [
        [windowMocks.isMaximized, true],
        [windowMocks.isFullscreen, true],
        [windowMocks.isResizable, false],
      ] as const) {
        method.mockResolvedValue(disabledValue);
        await act(async () => {
          windowMocks.resizeListeners.forEach((handler) => handler());
        });
        moveToEdge();
        expect(header.style.cursor).toBe("");
        fireEvent.mouseDown(header, { button: 0, clientX: 500, clientY: 1 });
        method.mockResolvedValue(!disabledValue);
        await act(async () => {
          windowMocks.resizeListeners.forEach((handler) => handler());
        });
        moveToEdge();
        expect(header.style.cursor).toBe("ns-resize");
      }
      expect(documentMouseDown).toHaveBeenCalledTimes(3);
    } finally {
      document.removeEventListener("mousedown", documentMouseDown);
    }
  });
});
