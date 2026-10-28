/**
 * Fork 在 `@/lib/api/model-fetch` 和 `@/lib/api/copilot` 上加了按管理目标分流的
 * 包装函数（本机走上游原函数，远端走 helper）。上游单测整体 mock 这两个模块、只提供
 * 上游原函数，包装函数在 mock 里就成了 undefined，表单点「获取模型」时直接抛错。
 *
 * 这里按真实实现的本机分支重写这些包装函数，转发给测试里 mock 的上游原函数，
 * 让上游单测继续断言 `fetchModelsForConfig` / `copilotGetModelsForAccount` 等调用。
 * 远端分支不在这些单测的覆盖范围内，调用时直接报错，避免悄悄走错目标。
 *
 * 用法（在 vi.mock 工厂里）：
 *   vi.mock("@/lib/api/model-fetch", async () => {
 *     const { withForkModelFetch } = await import("../utils/forkModelFetchMocks");
 *     return withForkModelFetch({ fetchModelsForConfig: api.fetchModelsForConfig, ... });
 *   });
 */
import type { ManagementTarget } from "@/lib/api";

type AnyFn = (...args: any[]) => any;

interface ProviderConfigOptions {
  target?: ManagementTarget;
  providerId?: string;
  baseUrl: string;
  apiKey: string;
  isFullUrl?: boolean;
  modelsUrl?: string;
  customUserAgent?: string;
  apiFormat?: string;
  requestHeaders?: Record<string, string>;
}

function rejectRemote(name: string): never {
  throw new Error(
    `${name}: remote target is not covered by this upstream test mock`,
  );
}

export function withForkModelFetch<
  T extends { fetchModelsForConfig: AnyFn } & Record<string, unknown>,
>(base: T) {
  return {
    canUseStoredRemoteProviderApiKey: (
      target: ManagementTarget | undefined,
      providerId: string | undefined,
    ) => target?.type === "remote" && Boolean(providerId?.trim()),
    modelFetchRequestHeaders: () => undefined,
    fetchModelsForProviderConfig: (options: ProviderConfigOptions) => {
      if (options.target?.type === "remote") {
        rejectRemote("fetchModelsForProviderConfig");
      }
      return base.fetchModelsForConfig(
        options.baseUrl,
        options.apiKey,
        options.isFullUrl,
        options.modelsUrl,
        options.customUserAgent,
        {
          apiFormat: options.apiFormat,
          requestHeaders: options.requestHeaders,
        },
      );
    },
    ...base,
  };
}

export function withForkCopilot<
  T extends {
    copilotGetModels: AnyFn;
    copilotGetModelsForAccount: AnyFn;
  } & Record<string, unknown>,
>(base: T) {
  return {
    copilotGetModelsForTarget: (
      accountId?: string | null,
      target?: ManagementTarget,
    ) => {
      if (target?.type === "remote") rejectRemote("copilotGetModelsForTarget");
      return accountId
        ? base.copilotGetModelsForAccount(accountId)
        : base.copilotGetModels();
    },
    ...base,
  };
}
