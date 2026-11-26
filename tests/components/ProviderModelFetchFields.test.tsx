import { act, fireEvent, screen, waitFor } from "@testing-library/react";
import { renderWithQueryClient as render } from "../utils/testQueryClient";
import type { ComponentProps } from "react";
import type { PropsWithChildren } from "react";
import { useForm } from "react-hook-form";
import { beforeEach, describe, expect, it, vi } from "vitest";
import { CodexFormFields } from "@/components/providers/forms/CodexFormFields";
import { GeminiFormFields } from "@/components/providers/forms/GeminiFormFields";
import { HermesFormFields } from "@/components/providers/forms/HermesFormFields";
import { OpenClawFormFields } from "@/components/providers/forms/OpenClawFormFields";
import { OpenCodeFormFields } from "@/components/providers/forms/OpenCodeFormFields";
import { Form } from "@/components/ui/form";
import type { AppId, ManagementTarget } from "@/lib/api";
import type { FetchedModel } from "@/lib/api/model-fetch";

const modelFetchApiMock = vi.hoisted(() => ({
  canUseStoredRemoteProviderApiKey: vi.fn(),
  fetchModelsForProviderConfig: vi.fn(),
  showFetchModelsError: vi.fn(),
}));

vi.mock("@/lib/api/model-fetch", () => ({
  canUseStoredRemoteProviderApiKey:
    modelFetchApiMock.canUseStoredRemoteProviderApiKey,
  fetchModelsForProviderConfig: modelFetchApiMock.fetchModelsForProviderConfig,
  // 上游 v4.0.21 起表单会把请求头覆盖一并传给获取模型
  modelFetchRequestHeaders: () => undefined,
  showFetchModelsError: modelFetchApiMock.showFetchModelsError,
}));

vi.mock("sonner", () => ({
  toast: {
    info: vi.fn(),
    success: vi.fn(),
    error: vi.fn(),
  },
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
};

const clickFetchModels = async () => {
  let button =
    screen.queryByTitle("providerForm.fetchModels") ??
    screen.queryByRole("button", { name: "providerForm.fetchModels" });

  if (!button) {
    const advancedButton = screen.queryByRole("button", { name: "高级选项" });
    if (advancedButton) {
      fireEvent.click(advancedButton);
      button = await screen.findByRole("button", {
        name: "providerForm.fetchModels",
      });
    }
  }

  fireEvent.click(
    button ?? screen.getByRole("button", { name: "providerForm.fetchModels" }),
  );
};

const FormShell = ({ children }: PropsWithChildren) => {
  const form = useForm();
  return <Form {...form}>{children}</Form>;
};

const renderField = (node: React.ReactElement) => {
  return render(<FormShell>{node}</FormShell>);
};

const deferredModels = () => {
  let resolve!: (models: FetchedModel[]) => void;
  let reject!: (error: Error) => void;
  const promise = new Promise<FetchedModel[]>((onResolve, onReject) => {
    resolve = onResolve;
    reject = onReject;
  });
  return { promise, resolve, reject };
};

describe("provider model fetch fields", () => {
  beforeEach(() => {
    vi.resetAllMocks();
    modelFetchApiMock.canUseStoredRemoteProviderApiKey.mockImplementation(
      (target, providerId) => target?.type === "remote" && Boolean(providerId),
    );
    modelFetchApiMock.fetchModelsForProviderConfig.mockResolvedValue([
      { id: "model-a", ownedBy: "test" },
    ]);
  });

  it.each([
    ["codex", "remote-codex"],
    ["gemini", "remote-gemini"],
    ["opencode", "remote-opencode"],
    ["openclaw", "remote-openclaw"],
    ["hermes", "remote-hermes"],
  ] as const)(
    "远程编辑 %s 供应商时 API Key 留空也用远端已保存密钥获取模型",
    async (appId, providerId) => {
      renderRemoteModelFetchField(appId, providerId);

      await clickFetchModels();

      await waitFor(() =>
        expect(
          modelFetchApiMock.fetchModelsForProviderConfig,
        ).toHaveBeenCalledWith(
          expect.objectContaining({
            app: appId,
            providerId,
            target: remoteTarget,
            baseUrl: "https://api.example.com/v1",
            apiKey: "",
          }),
        ),
      );
      expect(modelFetchApiMock.showFetchModelsError).not.toHaveBeenCalledWith(
        null,
        expect.any(Function),
        expect.objectContaining({ hasApiKey: false }),
      );
    },
  );
  it.each(["openclaw", "hermes"] as const)(
    "%s keeps only the current target's models when requests resolve out of order",
    async (app) => {
      const old = deferredModels();
      const current = deferredModels();
      modelFetchApiMock.fetchModelsForProviderConfig
        .mockReturnValueOnce(old.promise)
        .mockReturnValueOnce(current.promise);
      const target: ManagementTarget = {
        ...remoteTarget,
        profile: {
          ...remoteTarget.profile,
          id: "other-host",
          host: "192.0.2.11",
        },
      };
      const next = {
        apiKey: "second-fixture-key",
        baseUrl: "https://next.example.com/v1",
        modelFetchTarget: target,
      };
      const view = renderField(
        modelFetchField(app, "saved", { apiKey: "first-fixture-key" }),
      );
      await clickFetchModels();
      view.rerender(
        <FormShell>{modelFetchField(app, "saved", next)}</FormShell>,
      );
      await clickFetchModels();
      expect(
        modelFetchApiMock.fetchModelsForProviderConfig,
      ).toHaveBeenLastCalledWith(
        expect.objectContaining({
          app,
          target,
          apiKey: next.apiKey,
          baseUrl: next.baseUrl,
        }),
      );
      await act(async () =>
        current.resolve([{ id: "current-model", ownedBy: null }]),
      );
      await act(async () =>
        old.resolve([{ id: "stale-model", ownedBy: null }]),
      );
      fireEvent.click(
        screen.getByRole("button", {
          name: /Select model|providerForm.searchModelAriaLabel/,
        }),
      );
      expect(
        await screen.findByRole("option", { name: "current-model" }),
      ).toBeInTheDocument();
      expect(
        screen.queryByRole("option", { name: "stale-model" }),
      ).not.toBeInTheDocument();
    },
  );

  it.each(["opencode", "openclaw", "hermes"] as const)(
    "%s preserves an equivalent target rerender and ignores errors after close/reopen",
    async (app) => {
      const closed = deferredModels();
      const current = deferredModels();
      modelFetchApiMock.fetchModelsForProviderConfig
        .mockReturnValueOnce(closed.promise)
        .mockReturnValueOnce(current.promise);
      const view = renderField(modelFetchField(app, "saved"));
      await clickFetchModels();
      view.rerender(<FormShell />);
      view.rerender(<FormShell>{modelFetchField(app, "saved")}</FormShell>);
      await clickFetchModels();
      view.rerender(
        <FormShell>
          {modelFetchField(app, "saved", {
            modelFetchTarget: {
              ...remoteTarget,
              profile: {
                ...remoteTarget.profile,
                authMethod: { ...remoteTarget.profile.authMethod },
              },
            },
          })}
        </FormShell>,
      );
      await act(async () => closed.reject(new Error("closed fixture request")));
      expect(modelFetchApiMock.showFetchModelsError).not.toHaveBeenCalled();
      await clickFetchModels();
      expect(
        modelFetchApiMock.fetchModelsForProviderConfig,
      ).toHaveBeenCalledTimes(2);
      await act(async () => current.resolve([]));
      await clickFetchModels();
      expect(
        modelFetchApiMock.fetchModelsForProviderConfig,
      ).toHaveBeenCalledTimes(3);
    },
  );

  it.each(["opencode", "openclaw", "hermes"] as const)(
    "%s ignores a stale failure and keeps the new request pending when only the SSH password changes",
    async (app) => {
      const stale = deferredModels();
      const current = deferredModels();
      modelFetchApiMock.fetchModelsForProviderConfig
        .mockReturnValueOnce(stale.promise)
        .mockReturnValueOnce(current.promise);
      const firstTarget = {
        ...remoteTarget,
        secret: { password: "first-ssh-fixture" },
      };
      const nextTarget = {
        ...remoteTarget,
        secret: { password: "second-ssh-fixture" },
      };
      const view = renderField(
        modelFetchField(app, "saved", { modelFetchTarget: firstTarget }),
      );
      await clickFetchModels();
      view.rerender(
        <FormShell>
          {modelFetchField(app, "saved", { modelFetchTarget: nextTarget })}
        </FormShell>,
      );
      await clickFetchModels();
      expect(
        modelFetchApiMock.fetchModelsForProviderConfig,
      ).toHaveBeenCalledTimes(2);
      await act(async () => stale.reject(new Error("stale fixture request")));
      expect(modelFetchApiMock.showFetchModelsError).not.toHaveBeenCalled();
      await clickFetchModels();
      expect(
        modelFetchApiMock.fetchModelsForProviderConfig,
      ).toHaveBeenCalledTimes(2);
      await act(async () => current.resolve([]));
      await clickFetchModels();
      expect(
        modelFetchApiMock.fetchModelsForProviderConfig,
      ).toHaveBeenCalledTimes(3);
    },
  );
});

function renderRemoteModelFetchField(appId: AppId, providerId: string) {
  return renderField(modelFetchField(appId, providerId));
}

function modelFetchField(
  appId: AppId,
  providerId: string,
  overrides?: {
    apiKey?: string;
    baseUrl?: string;
    modelFetchTarget?: ManagementTarget;
  },
) {
  const baseProps = {
    providerId,
    modelFetchTarget: remoteTarget,
    category: "custom" as const,
    apiKeyPlaceholder: "Leave blank to keep the current API key.",
    shouldShowApiKeyLink: false,
    websiteUrl: "",
    isPartner: false,
    partnerPromotionKey: undefined,
  };

  if (appId === "codex") {
    const props: ComponentProps<typeof CodexFormFields> = {
      ...baseProps,
      codexApiKey: "",
      onApiKeyChange: vi.fn(),
      shouldShowSpeedTest: false,
      codexBaseUrl: "https://api.example.com/v1",
      onBaseUrlChange: vi.fn(),
      isFullUrl: false,
      onFullUrlChange: vi.fn(),
      isEndpointModalOpen: false,
      onEndpointModalToggle: vi.fn(),
      onCustomEndpointsChange: vi.fn(),
      autoSelect: false,
      onAutoSelectChange: vi.fn(),
      apiFormat: "openai_chat",
      onApiFormatChange: vi.fn(),
      anthropicAuthField: "ANTHROPIC_AUTH_TOKEN",
      onAnthropicAuthFieldChange: vi.fn(),
      impersonateClaudeCode: false,
      onImpersonateClaudeCodeChange: vi.fn(),
      maxOutputTokens: "",
      onMaxOutputTokensChange: vi.fn(),
      promptCacheRouting: "auto",
      onPromptCacheRoutingChange: vi.fn(),
      catalogModels: [],
      onCatalogModelsChange: vi.fn(),
      speedTestEndpoints: [],
      customUserAgent: "",
      onCustomUserAgentChange: vi.fn(),
      localProxyHeadersOverride: "",
      onLocalProxyHeadersOverrideChange: vi.fn(),
      localProxyBodyOverride: "",
      onLocalProxyBodyOverrideChange: vi.fn(),
    };
    return <CodexFormFields {...props} />;
  }

  if (appId === "gemini") {
    const props: ComponentProps<typeof GeminiFormFields> = {
      ...baseProps,
      shouldShowApiKey: true,
      apiKey: "",
      onApiKeyChange: vi.fn(),
      shouldShowSpeedTest: false,
      baseUrl: "https://api.example.com/v1",
      onBaseUrlChange: vi.fn(),
      isEndpointModalOpen: false,
      onEndpointModalToggle: vi.fn(),
      onCustomEndpointsChange: vi.fn(),
      autoSelect: false,
      onAutoSelectChange: vi.fn(),
      shouldShowModelField: true,
      model: "",
      onModelChange: vi.fn(),
      speedTestEndpoints: [],
    };
    return <GeminiFormFields {...props} />;
  }

  if (appId === "opencode") {
    const props: ComponentProps<typeof OpenCodeFormFields> = {
      ...baseProps,
      npm: "@ai-sdk/openai-compatible",
      onNpmChange: vi.fn(),
      apiKey: "",
      onApiKeyChange: vi.fn(),
      baseUrl: "https://api.example.com/v1",
      onBaseUrlChange: vi.fn(),
      headers: {},
      onHeadersChange: vi.fn(),
      models: {},
      onModelsChange: vi.fn(),
      extraOptions: {},
      onExtraOptionsChange: vi.fn(),
      ...overrides,
    };
    return <OpenCodeFormFields {...props} />;
  }

  if (appId === "openclaw") {
    const props: ComponentProps<typeof OpenClawFormFields> = {
      ...baseProps,
      baseUrl: "https://api.example.com/v1",
      onBaseUrlChange: vi.fn(),
      apiKey: "",
      onApiKeyChange: vi.fn(),
      api: "openai-completions",
      onApiChange: vi.fn(),
      models: [{ id: "existing", name: "Existing" }],
      onModelsChange: vi.fn(),
      userAgent: true,
      onUserAgentChange: vi.fn(),
      ...overrides,
    };
    return <OpenClawFormFields {...props} />;
  }

  const props: ComponentProps<typeof HermesFormFields> = {
    ...baseProps,
    baseUrl: "https://api.example.com/v1",
    onBaseUrlChange: vi.fn(),
    apiKey: "",
    onApiKeyChange: vi.fn(),
    apiMode: "chat_completions",
    onApiModeChange: vi.fn(),
    models: [{ id: "existing", name: "Existing" }],
    onModelsChange: vi.fn(),
    rateLimitDelay: undefined,
    onRateLimitDelayChange: vi.fn(),
    ...overrides,
  };
  return <HermesFormFields {...props} />;
}
