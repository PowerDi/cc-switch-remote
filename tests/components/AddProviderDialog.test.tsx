import {
  act,
  fireEvent,
  render,
  screen,
  waitFor,
} from "@testing-library/react";
import { useEffect } from "react";
import { beforeEach, describe, expect, it, vi } from "vitest";
import { AddProviderDialog } from "@/components/providers/AddProviderDialog";
import type { ProviderFormValues } from "@/components/providers/forms/ProviderForm";
import { codexProviderPresets } from "@/config/codexProviderPresets";
import type { UniversalProviderPreset } from "@/config/universalProviderPresets";
import type { ManagementTarget } from "@/lib/api";
import type { UniversalProvider } from "@/types";

vi.mock("@/components/ui/dialog", () => ({
  Dialog: ({ children }: { children: React.ReactNode }) => (
    <div>{children}</div>
  ),
  DialogContent: ({ children }: { children: React.ReactNode }) => (
    <div>{children}</div>
  ),
  DialogHeader: ({ children }: { children: React.ReactNode }) => (
    <div>{children}</div>
  ),
  DialogTitle: ({ children }: { children: React.ReactNode }) => (
    <h1>{children}</h1>
  ),
  DialogDescription: ({ children }: { children: React.ReactNode }) => (
    <p>{children}</p>
  ),
  DialogFooter: ({ children }: { children: React.ReactNode }) => (
    <div>{children}</div>
  ),
}));

let mockFormValues: ProviderFormValues;
let mockFormReady = true;
// 表单把预设投影到配置文件上之后交给对话框的底（Codex、Gemini CLI、Grok Build）。
let mockProjectedBase: Record<string, unknown> | null = null;
// 投影成那份底的草稿（预设或模板）。
let mockProjectedDraft: Record<string, unknown> | undefined;
let submitReadyCallbacks: Array<(isReady: boolean) => void> = [];

const apiMocks = vi.hoisted(() => ({
  getAllUniversalProviders: vi.fn(),
  upsertUniversalProvider: vi.fn(),
  syncUniversalProvider: vi.fn(),
}));

vi.mock("@/lib/api/providers", async () => {
  const actual = await vi.importActual<typeof import("@/lib/api/providers")>(
    "@/lib/api/providers",
  );
  return {
    ...actual,
    universalProvidersApi: {
      getAll: (...args: unknown[]) =>
        apiMocks.getAllUniversalProviders(...args),
      upsert: (...args: unknown[]) => apiMocks.upsertUniversalProvider(...args),
      sync: (...args: unknown[]) => apiMocks.syncUniversalProvider(...args),
    },
  };
});

const universalProviderFromModal: UniversalProvider = {
  id: "universal-remote-provider",
  name: "Remote Unified Provider",
  providerType: "newapi",
  baseUrl: "https://api.example.com",
  apiKey: "sk-test",
  apps: { claude: true, codex: true, gemini: true },
  models: {},
};

vi.mock("@/components/universal/UniversalProviderFormModal", () => ({
  UniversalProviderFormModal: ({
    isOpen,
    onSave,
  }: {
    isOpen: boolean;
    onSave: (provider: UniversalProvider) => void;
  }) =>
    isOpen ? (
      <button type="button" onClick={() => onSave(universalProviderFromModal)}>
        save-universal-provider
      </button>
    ) : null,
}));

vi.mock("@/components/providers/forms/ProviderForm", () => ({
  ProviderForm: ({
    onSubmit,
    onSubmitReadyChange,
    onManageAuthAccounts,
    onEditorBaseChange,
    onUniversalPresetSelect,
  }: {
    onSubmit: (values: ProviderFormValues) => void;
    onSubmitReadyChange?: (isReady: boolean) => void;
    onManageAuthAccounts?: (target: "codex_oauth") => void;
    onEditorBaseChange?: (
      base: Record<string, unknown> | null,
      draft?: Record<string, unknown>,
    ) => void;
    onUniversalPresetSelect?: (preset: UniversalProviderPreset) => void;
  }) => {
    useEffect(() => {
      if (onSubmitReadyChange) {
        submitReadyCallbacks.push(onSubmitReadyChange);
        onSubmitReadyChange(mockFormReady);
      }
    }, [onSubmitReadyChange]);
    useEffect(() => {
      onEditorBaseChange?.(mockProjectedBase, mockProjectedDraft);
    }, [onEditorBaseChange]);
    return (
      <form
        id="provider-form"
        onSubmit={(event) => {
          event.preventDefault();
          onSubmit(mockFormValues);
        }}
      >
        <button
          type="button"
          onClick={() => onManageAuthAccounts?.("codex_oauth")}
        >
          manage-auth
        </button>
        <button
          type="button"
          onClick={() =>
            onUniversalPresetSelect?.({
              key: "newapi",
            } as unknown as UniversalProviderPreset)
          }
        >
          pick-universal
        </button>
      </form>
    );
  },
}));

vi.mock("@/components/providers/AuthSettingsPanel", () => ({
  AuthSettingsPanel: ({ target }: { target: string | null }) =>
    target ? <div data-testid="auth-settings-panel">{target}</div> : null,
}));

describe("AddProviderDialog", () => {
  beforeEach(() => {
    mockFormReady = true;
    mockProjectedBase = null;
    mockProjectedDraft = undefined;
    submitReadyCallbacks = [];
    apiMocks.getAllUniversalProviders.mockReset().mockResolvedValue({});
    apiMocks.upsertUniversalProvider.mockReset().mockResolvedValue(undefined);
    apiMocks.syncUniversalProvider.mockReset().mockResolvedValue(undefined);
    mockFormValues = {
      name: "Test Provider",
      websiteUrl: "https://provider.example.com",
      settingsConfig: JSON.stringify({ env: {}, config: {} }),
      meta: {
        custom_endpoints: {
          "https://api.new-endpoint.com": {
            url: "https://api.new-endpoint.com",
            addedAt: 1,
          },
        },
      },
    };
  });

  it("使用 ProviderForm 返回的自定义端点", async () => {
    const handleSubmit = vi.fn().mockResolvedValue(undefined);
    const handleOpenChange = vi.fn();

    render(
      <AddProviderDialog
        open
        onOpenChange={handleOpenChange}
        appId="claude"
        onSubmit={handleSubmit}
      />,
    );

    // Claude 的表单要等 live 底读回来才渲染。
    await screen.findByRole("button", { name: "manage-auth" });
    fireEvent.click(
      await screen.findByRole("button", {
        name: "common.add",
      }),
    );

    await waitFor(() => expect(handleSubmit).toHaveBeenCalledTimes(1));

    const submitted = handleSubmit.mock.calls[0][0];
    expect(submitted.meta?.custom_endpoints).toEqual(
      mockFormValues.meta?.custom_endpoints,
    );
    // 保存时带上打开时的 live 底，后端据此把全局改动写进 live、三方比较。
    expect(submitted.editorSave).toEqual({ base: {}, onConflict: "refuse" });
    expect(handleOpenChange).toHaveBeenCalledWith(false);
  });

  it("在缺少自定义端点时回退到配置中的 baseUrl", async () => {
    const handleSubmit = vi.fn().mockResolvedValue(undefined);

    mockFormValues = {
      name: "Base URL Provider",
      websiteUrl: "",
      settingsConfig: JSON.stringify({
        env: { ANTHROPIC_BASE_URL: "https://claude.base" },
        config: {},
      }),
    };

    render(
      <AddProviderDialog
        open
        onOpenChange={vi.fn()}
        appId="claude"
        onSubmit={handleSubmit}
      />,
    );

    await screen.findByRole("button", { name: "manage-auth" });
    fireEvent.click(
      await screen.findByRole("button", {
        name: "common.add",
      }),
    );

    await waitFor(() => expect(handleSubmit).toHaveBeenCalledTimes(1));

    const submitted = handleSubmit.mock.calls[0][0];
    expect(submitted.meta?.custom_endpoints).toEqual({
      "https://claude.base": {
        url: "https://claude.base",
        addedAt: expect.any(Number),
        lastUsed: undefined,
      },
    });
  });

  it.each(["codex", "gemini", "grokbuild"] as const)(
    "%s 新增时带上表单投影出的底，和编辑器同一套保存规则",
    async (appId) => {
      const handleSubmit = vi.fn().mockResolvedValue(undefined);
      const projected = { config: '[ui]\ntheme = "dark"\n' };
      const draft = { config: "" };
      mockProjectedBase = projected;
      mockProjectedDraft = draft;
      mockFormValues = {
        name: "Draft",
        websiteUrl: "",
        settingsConfig: JSON.stringify(projected),
      };

      render(
        <AddProviderDialog
          open
          onOpenChange={vi.fn()}
          appId={appId}
          onSubmit={handleSubmit}
        />,
      );

      await screen.findByRole("button", { name: "manage-auth" });
      fireEvent.click(
        await screen.findByRole("button", { name: "common.add" }),
      );

      await waitFor(() => expect(handleSubmit).toHaveBeenCalledTimes(1));
      expect(handleSubmit.mock.calls[0][0].editorSave).toEqual({
        base: projected,
        draft,
        onConflict: "refuse",
      });
    },
  );

  it("投影还没回来或失败时只存供应商，不带底", async () => {
    const handleSubmit = vi.fn().mockResolvedValue(undefined);
    mockProjectedBase = null;
    mockFormValues = {
      name: "Draft",
      websiteUrl: "",
      settingsConfig: JSON.stringify({ auth: {}, config: "" }),
    };

    render(
      <AddProviderDialog
        open
        onOpenChange={vi.fn()}
        appId="codex"
        onSubmit={handleSubmit}
      />,
    );

    await screen.findByRole("button", { name: "manage-auth" });
    fireEvent.click(await screen.findByRole("button", { name: "common.add" }));

    await waitFor(() => expect(handleSubmit).toHaveBeenCalledTimes(1));
    expect(handleSubmit.mock.calls[0][0].editorSave).toBeUndefined();
  });

  it("submits the optional managed account from the Codex Official preset", async () => {
    const handleSubmit = vi.fn().mockResolvedValue(undefined);
    const officialPresetIndex = codexProviderPresets.findIndex(
      (preset) =>
        preset.category === "official" && preset.providerType === "codex_oauth",
    );
    expect(officialPresetIndex).toBeGreaterThanOrEqual(0);

    mockFormValues = {
      name: "OpenAI Official",
      websiteUrl: "https://chatgpt.com/codex",
      settingsConfig: JSON.stringify({ auth: {}, config: "" }),
      presetId: `codex-${officialPresetIndex}`,
      presetCategory: "official",
      meta: {
        providerType: "codex_oauth",
        authBinding: {
          source: "managed_account",
          authProvider: "codex_oauth",
          accountId: "acct-managed",
        },
      },
    };

    render(
      <AddProviderDialog
        open
        onOpenChange={vi.fn()}
        appId="codex"
        onSubmit={handleSubmit}
      />,
    );

    fireEvent.click(await screen.findByRole("button", { name: "common.add" }));

    await waitFor(() => expect(handleSubmit).toHaveBeenCalledTimes(1));
    expect(handleSubmit).toHaveBeenCalledWith(
      expect.objectContaining({
        category: "official",
        meta: expect.objectContaining({
          authBinding: {
            source: "managed_account",
            authProvider: "codex_oauth",
            accountId: "acct-managed",
          },
        }),
      }),
    );
    expect(handleSubmit.mock.calls[0][0]).not.toHaveProperty(
      "ensureCodexOfficialSeed",
    );
  });

  it("clears the nested auth panel before the dialog reopens", async () => {
    const props = {
      onOpenChange: vi.fn(),
      appId: "codex" as const,
      onSubmit: vi.fn(),
    };
    const { rerender } = render(<AddProviderDialog open {...props} />);

    fireEvent.click(screen.getByRole("button", { name: "manage-auth" }));
    expect(screen.getByTestId("auth-settings-panel")).toHaveTextContent(
      "codex_oauth",
    );

    rerender(<AddProviderDialog open={false} {...props} />);
    rerender(<AddProviderDialog open {...props} />);

    await waitFor(() => {
      expect(
        screen.queryByTestId("auth-settings-panel"),
      ).not.toBeInTheDocument();
    });
  });

  it("新建 Grok Build 自定义供应商时不补默认 Grok 图标", async () => {
    const handleSubmit = vi.fn().mockResolvedValue(undefined);

    mockFormValues = {
      name: "tes 1",
      websiteUrl: "",
      icon: "",
      iconColor: "",
      settingsConfig: JSON.stringify({
        config: `[models]
default = "grok-4.5"

[model."grok-4.5"]
model = "grok-4.5"
base_url = "https://grok.example.com/v1"
name = "tes 1"
api_key = "secret"
api_backend = "responses"
context_window = 500000
`,
      }),
    };

    render(
      <AddProviderDialog
        open
        onOpenChange={vi.fn()}
        appId="grokbuild"
        onSubmit={handleSubmit}
      />,
    );

    fireEvent.click(await screen.findByRole("button", { name: "common.add" }));

    await waitFor(() => expect(handleSubmit).toHaveBeenCalledTimes(1));

    const submitted = handleSubmit.mock.calls[0][0];
    expect(submitted.icon).toBeUndefined();
    expect(submitted.iconColor).toBeUndefined();
  });

  it("Pi 添加供应商时仅提交供应商目录", async () => {
    const handleSubmit = vi.fn().mockResolvedValue(undefined);
    mockFormValues = {
      name: "Pi Provider",
      providerKey: "pi-provider",
      websiteUrl: "",
      settingsConfig: JSON.stringify({
        baseUrl: "https://api.example.com/v1",
        models: [
          { id: "selected-model", name: "Selected" },
          { id: "other-model", name: "Other" },
        ],
      }),
      meta: {
        isPartner: true,
        endpointAutoSelect: true,
        custom_endpoints: {
          "https://failover.example.com/v1": {
            url: "https://failover.example.com/v1",
            addedAt: 1,
          },
        },
      },
    };

    render(
      <AddProviderDialog
        open
        onOpenChange={vi.fn()}
        appId="pi"
        onSubmit={handleSubmit}
      />,
    );

    fireEvent.click(await screen.findByRole("button", { name: "common.add" }));
    await waitFor(() => expect(handleSubmit).toHaveBeenCalledTimes(1));
    expect(handleSubmit.mock.calls[0][0]).toMatchObject({
      providerKey: "pi-provider",
      meta: { isPartner: true },
    });
    expect(handleSubmit.mock.calls[0][0]).not.toHaveProperty(
      "piActivateModelId",
    );
  });

  it("重新打开 Pi 表单后忽略上一轮的就绪回调", async () => {
    const props = {
      onOpenChange: vi.fn(),
      appId: "pi" as const,
      onSubmit: vi.fn(),
    };
    const { rerender } = render(<AddProviderDialog open {...props} />);

    const addButton = await screen.findByRole("button", { name: "common.add" });
    await waitFor(() => expect(addButton).toBeEnabled());
    const staleCallback = submitReadyCallbacks.at(-1);
    expect(staleCallback).toBeDefined();

    rerender(<AddProviderDialog open={false} {...props} />);
    mockFormReady = false;
    rerender(<AddProviderDialog open {...props} />);
    const reopenedButton = await screen.findByRole("button", {
      name: "common.add",
    });
    await waitFor(() => expect(reopenedButton).toBeDisabled());

    act(() => staleCallback?.(true));
    expect(reopenedButton).toBeDisabled();
  });

  it("添加远程统一供应商后同步到具体应用供应商配置", async () => {
    const remoteTarget: ManagementTarget = {
      type: "remote",
      profile: {
        id: "remote-1",
        name: "Remote Host",
        host: "192.168.123.206",
        port: 22,
        username: "root",
        authMethod: { type: "password" },
        helperPath: "/root/.local/bin/cc-switch-remote-helper",
        createdAt: 1,
        updatedAt: 1,
      },
    };

    const handleOpenChange = vi.fn();

    render(
      <AddProviderDialog
        open
        onOpenChange={handleOpenChange}
        appId="claude"
        target={remoteTarget}
        onSubmit={vi.fn()}
      />,
    );

    // Claude 的表单要等 live 底读回来才渲染。
    // v4 把"统一供应商"入口放进表单的预设选择里：点它打开弹窗
    fireEvent.click(
      await screen.findByRole("button", { name: "pick-universal" }),
    );
    fireEvent.click(
      screen.getByRole("button", { name: "save-universal-provider" }),
    );

    await waitFor(() =>
      expect(apiMocks.upsertUniversalProvider).toHaveBeenCalledWith(
        universalProviderFromModal,
        remoteTarget,
      ),
    );
    expect(apiMocks.syncUniversalProvider).toHaveBeenCalledWith(
      "universal-remote-provider",
      remoteTarget,
    );
    expect(handleOpenChange).toHaveBeenCalledWith(false);
  });
});
