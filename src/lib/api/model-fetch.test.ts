import { beforeEach, describe, expect, it, vi } from "vitest";
import {
  fetchCodexOauthModels,
  fetchModelsForProviderConfig,
  getOpenCodeModels,
} from "./model-fetch";
import type { ManagementTarget, RemoteHostProfile } from "./remote";

const invokeMock = vi.hoisted(() => vi.fn());
const remoteFetchCodexOauthModelsMock = vi.hoisted(() => vi.fn());
const remoteFetchModelsForProviderMock = vi.hoisted(() => vi.fn());
const remoteGetOpenCodeModelsMock = vi.hoisted(() => vi.fn());

vi.mock("@tauri-apps/api/core", () => ({
  invoke: (...args: unknown[]) => invokeMock(...args),
}));

vi.mock("./remote", async () => {
  const actual = await vi.importActual<typeof import("./remote")>("./remote");
  return {
    ...actual,
    remoteApi: {
      ...actual.remoteApi,
      fetchCodexOauthModels: (...args: unknown[]) =>
        remoteFetchCodexOauthModelsMock(...args),
      fetchModelsForProvider: (...args: unknown[]) =>
        remoteFetchModelsForProviderMock(...args),
      getOpenCodeModels: (...args: unknown[]) =>
        remoteGetOpenCodeModelsMock(...args),
    },
  };
});

const remoteProfile: RemoteHostProfile = {
  id: "remote-host",
  name: "Remote Host",
  host: "192.0.2.10",
  port: 22,
  username: "root",
  authMethod: { type: "sshAgent" },
  helperPath: "/root/.local/bin/cc-switch-remote-helper",
  createdAt: 1,
  updatedAt: 1,
};

const remoteTarget: ManagementTarget = {
  type: "remote",
  profile: remoteProfile,
  secret: { password: "secret" },
};

describe("fetchModelsForProviderConfig", () => {
  beforeEach(() => {
    invokeMock.mockReset();
    remoteFetchModelsForProviderMock.mockReset();
  });

  it("keeps remote model fetches on the helper even when the form contains a key", async () => {
    remoteFetchModelsForProviderMock.mockResolvedValueOnce([
      { id: "remote-model", ownedBy: null },
    ]);

    await expect(
      fetchModelsForProviderConfig({
        app: "pi",
        providerId: " remote-provider ",
        target: remoteTarget,
        baseUrl: "https://api.example.com",
        apiKey: "unsaved-secret",
        modelsUrl: "https://api.example.com/models",
      }),
    ).resolves.toEqual([{ id: "remote-model", ownedBy: null }]);

    expect(remoteFetchModelsForProviderMock).toHaveBeenCalledWith(
      remoteProfile,
      "pi",
      "remote-provider",
      {
        baseUrl: "https://api.example.com",
        isFullUrl: undefined,
        modelsUrl: "https://api.example.com/models",
        customUserAgent: undefined,
      },
      remoteTarget.secret,
    );
    expect(invokeMock).not.toHaveBeenCalled();
  });

  it("rejects unsaved remote providers without falling back to local invoke", async () => {
    await expect(
      fetchModelsForProviderConfig({
        app: "pi",
        providerId: undefined,
        target: remoteTarget,
        baseUrl: "https://api.example.com",
        apiKey: "unsaved-secret",
      }),
    ).rejects.toThrow("Remote model fetch requires a saved provider");

    expect(remoteFetchModelsForProviderMock).not.toHaveBeenCalled();
    expect(invokeMock).not.toHaveBeenCalled();
  });
});

describe("fetchCodexOauthModels", () => {
  beforeEach(() => {
    invokeMock.mockReset();
    remoteFetchCodexOauthModelsMock.mockReset();
    remoteGetOpenCodeModelsMock.mockReset();
  });

  it("uses the local Codex OAuth command for local targets", async () => {
    invokeMock.mockResolvedValueOnce([{ id: "gpt-5", ownedBy: null }]);

    await expect(fetchCodexOauthModels("local-account")).resolves.toEqual([
      { id: "gpt-5", ownedBy: null },
    ]);

    expect(invokeMock).toHaveBeenCalledWith("get_codex_oauth_models", {
      accountId: "local-account",
    });
    expect(remoteFetchCodexOauthModelsMock).not.toHaveBeenCalled();
  });

  it("uses the remote helper for remote targets", async () => {
    remoteFetchCodexOauthModelsMock.mockResolvedValueOnce([
      { id: "gpt-5-remote", ownedBy: null },
    ]);

    await expect(
      fetchCodexOauthModels("remote-account", remoteTarget),
    ).resolves.toEqual([{ id: "gpt-5-remote", ownedBy: null }]);

    expect(remoteFetchCodexOauthModelsMock).toHaveBeenCalledWith(
      remoteProfile,
      "remote-account",
      remoteTarget.secret,
    );
    expect(invokeMock).not.toHaveBeenCalled();
  });
});

describe("getOpenCodeModels", () => {
  beforeEach(() => {
    invokeMock.mockReset();
    remoteGetOpenCodeModelsMock.mockReset();
  });

  it("uses the local runtime-model command for a local target", async () => {
    invokeMock.mockResolvedValueOnce([
      { providerId: "local-oauth", modelId: "gpt-5-local" },
    ]);

    await expect(getOpenCodeModels()).resolves.toEqual([
      { providerId: "local-oauth", modelId: "gpt-5-local" },
    ]);

    expect(invokeMock).toHaveBeenCalledWith("get_opencode_models");
    expect(remoteGetOpenCodeModelsMock).not.toHaveBeenCalled();
  });

  it("uses only the remote helper for a remote target", async () => {
    remoteGetOpenCodeModelsMock.mockResolvedValueOnce([
      { providerId: "remote-oauth", modelId: "gpt-5-remote" },
    ]);

    await expect(getOpenCodeModels(remoteTarget)).resolves.toEqual([
      { providerId: "remote-oauth", modelId: "gpt-5-remote" },
    ]);

    expect(remoteGetOpenCodeModelsMock).toHaveBeenCalledWith(
      remoteProfile,
      remoteTarget.secret,
    );
    expect(invokeMock).not.toHaveBeenCalled();
  });
});

import { modelFetchRequestHeaders } from "./model-fetch";
describe("modelFetchRequestHeaders", () => {
  it("合法的 Header 覆盖 JSON 原样转为请求头（键名归一为小写）", () => {
    expect(
      modelFetchRequestHeaders('{\n  "cf-aig-authorization": "secret"\n}'),
    ).toEqual({ "cf-aig-authorization": "secret" });
    expect(modelFetchRequestHeaders('{"X-Custom":"a","x-lower":"b"}')).toEqual({
      "x-custom": "a",
      "x-lower": "b",
    });
  });

  it("空覆盖不携带请求头", () => {
    expect(modelFetchRequestHeaders("")).toBeUndefined();
    expect(modelFetchRequestHeaders("   \n  ")).toBeUndefined();
    expect(modelFetchRequestHeaders("{}")).toBeUndefined();
  });

  it("JSON 非法或结构不符合时静默回退（不阻断取模型）", () => {
    expect(modelFetchRequestHeaders("not json")).toBeUndefined();
    expect(modelFetchRequestHeaders('["array"]')).toBeUndefined();
    expect(modelFetchRequestHeaders('{"Name": 1}')).toBeUndefined();
    expect(modelFetchRequestHeaders('{"Bad Name!": "v"}')).toBeUndefined();
    expect(
      modelFetchRequestHeaders('{"dup": "a", "DUP": "b"}'),
    ).toBeUndefined();
  });

  it("本地代理托管头不允许借道模型列表请求", () => {
    expect(
      modelFetchRequestHeaders('{"authorization": "Bearer x"}'),
    ).toBeUndefined();
    expect(modelFetchRequestHeaders('{"x-api-key": "k"}')).toBeUndefined();
  });
});

describe("model fetch headers and protocol target parity", () => {
  beforeEach(() => {
    invokeMock.mockReset();
    remoteFetchModelsForProviderMock.mockReset();
  });
  it("preserves protocol, User-Agent and configured headers on the selected host", async () => {
    const requestHeaders = { "x-tenant": "tenant" };
    await fetchModelsForProviderConfig({
      app: "omp",
      providerId: "p",
      target: remoteTarget,
      baseUrl: "https://example.com",
      apiKey: "[redacted]",
      apiFormat: "anthropic",
      customUserAgent: "omp",
      requestHeaders,
    });
    expect(remoteFetchModelsForProviderMock).toHaveBeenCalledWith(
      remoteProfile,
      "omp",
      "p",
      {
        baseUrl: "https://example.com",
        isFullUrl: undefined,
        modelsUrl: undefined,
        customUserAgent: "omp",
        apiFormat: "anthropic",
        requestHeaders,
      },
      remoteTarget.secret,
    );
    expect(invokeMock).not.toHaveBeenCalled();
  });
  it("keeps the same options on the local model fetch command", async () => {
    const requestHeaders = { "x-tenant": "tenant" };
    await fetchModelsForProviderConfig({
      app: "omp",
      baseUrl: "https://example.com",
      apiKey: "key",
      apiFormat: "anthropic",
      requestHeaders,
    });
    expect(invokeMock).toHaveBeenCalledWith("fetch_models_for_config", {
      baseUrl: "https://example.com",
      apiKey: "key",
      isFullUrl: undefined,
      modelsUrl: undefined,
      customUserAgent: undefined,
      apiFormat: "anthropic",
      requestHeaders,
    });
    expect(remoteFetchModelsForProviderMock).not.toHaveBeenCalled();
  });
});
