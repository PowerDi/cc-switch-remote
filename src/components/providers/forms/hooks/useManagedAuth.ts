import { useState, useCallback, useRef, useEffect, useMemo } from "react";
import { useQuery, useMutation, useQueryClient } from "@tanstack/react-query";
import { useTranslation } from "react-i18next";
import { toast } from "@/lib/toast";
import { authApi, remoteApi, settingsApi } from "@/lib/api";
import { CODEX_OAUTH_DUPLICATE_ACCOUNT_ERROR } from "@/lib/api/auth";
import type { CodexLoginMethod } from "@/lib/api/auth";
import { copyText } from "@/lib/clipboard";
import {
  getManagementTargetKey,
  LOCAL_MANAGEMENT_TARGET,
} from "@/lib/managementTarget";
import type {
  ManagementTarget,
  ManagedAuthProvider,
  ManagedAuthStatus,
  ManagedAuthDeviceCodeResponse,
} from "@/lib/api";
import { useTargetQueryIdentityReset } from "@/hooks/useTargetQueryIdentityReset";

type PollingState = "idle" | "polling" | "success" | "error";
type LoginRequest = {
  targetAccountId?: string;
  generation: number;
  connectionGeneration: number;
  loginMethod?: CodexLoginMethod;
};

export function useManagedAuth(
  authProvider: ManagedAuthProvider,
  githubDomain?: string,
  target: ManagementTarget = LOCAL_MANAGEMENT_TARGET,
  loginMethod?: CodexLoginMethod,
) {
  const { t } = useTranslation();
  const queryClient = useQueryClient();
  const targetKey = getManagementTargetKey(target);
  const queryKey = useMemo(
    () => ["managed-auth-status", targetKey, authProvider],
    [authProvider, targetKey],
  );
  const connectionGeneration = useTargetQueryIdentityReset(
    "all",
    target,
    targetKey,
  );
  const connectionTargetRef = useRef({
    generation: connectionGeneration,
    target,
  });
  if (connectionTargetRef.current.generation !== connectionGeneration) {
    connectionTargetRef.current = { generation: connectionGeneration, target };
  }
  const connectionTarget = connectionTargetRef.current.target;
  const connectionGenerationRef = useRef(connectionGeneration);
  connectionGenerationRef.current = connectionGeneration;
  const isCurrentGeneration = useCallback(
    (generation: number) => connectionGenerationRef.current === generation,
    [],
  );

  const [pollingState, setPollingState] = useState<PollingState>("idle");
  const [deviceCode, setDeviceCode] =
    useState<ManagedAuthDeviceCodeResponse | null>(null);
  const [error, setError] = useState<string | null>(null);

  const pollingIntervalRef = useRef<ReturnType<typeof setInterval> | null>(
    null,
  );
  const pollingTimeoutRef = useRef<ReturnType<typeof setTimeout> | null>(null);
  const flowGenerationRef = useRef(0);
  const activeDeviceCodeRef = useRef<string | null>(null);
  const retryTargetAccountIdRef = useRef<string | undefined>(undefined);
  const flowTransitionRef = useRef<Promise<void>>(Promise.resolve());

  const remoteHealthQuery = useQuery({
    queryKey: ["remote-health", targetKey, connectionGeneration],
    queryFn: () => {
      if (target.type !== "remote") return null;
      return remoteApi.checkHealth(target.profile, target.secret);
    },
    enabled: target.type === "remote",
    retry: false,
    staleTime: 30_000,
  });
  const isAuthSupported =
    target.type === "local" ||
    (["github_copilot", "codex_oauth", "xai_oauth"].includes(authProvider) &&
      remoteHealthQuery.data?.capabilities.includes("auth") === true);
  const canTargetedReauth =
    isAuthSupported &&
    (target.type === "local" ||
      (authProvider === "codex_oauth" &&
        remoteHealthQuery.data?.capabilities.includes(
          "auth-targeted-relogin",
        ) === true));

  const {
    data: authStatus,
    isLoading: isAuthStatusLoading,
    isSuccess: isAuthStatusSuccess,
    isError: isAuthStatusError,
    refetch: refetchStatus,
  } = useQuery<ManagedAuthStatus>({
    queryKey,
    queryFn: () => authApi.authGetStatus(authProvider, target),
    enabled: isAuthSupported,
    staleTime: 30000,
    // A rejected xAI refresh token is persisted as `requires_reauth` by the
    // proxy hot path. Periodically refresh local status so an already-open Auth
    // Center stops showing the account as logged in without requiring a reload.
    refetchInterval: authProvider === "xai_oauth" ? 15_000 : false,
  });

  const refetchManagedAuthStatus = useCallback(async () => {
    if (target.type === "remote") {
      const health = await remoteHealthQuery.refetch();
      if (health.data?.capabilities.includes("auth") !== true) return health;
    }
    return refetchStatus();
  }, [refetchStatus, remoteHealthQuery, target.type]);

  const stopPolling = useCallback(() => {
    if (pollingIntervalRef.current) {
      clearInterval(pollingIntervalRef.current);
      pollingIntervalRef.current = null;
    }
    if (pollingTimeoutRef.current) {
      clearTimeout(pollingTimeoutRef.current);
      pollingTimeoutRef.current = null;
    }
  }, []);

  const cancelBackendFlow = useCallback(
    async (activeDeviceCode: string | null): Promise<boolean> => {
      if (
        !activeDeviceCode ||
        (authProvider !== "codex_oauth" &&
          authProvider !== "agy_oauth" &&
          authProvider !== "claude_official")
      )
        return true;
      try {
        const cancelled = await authApi.authCancelLogin(
          authProvider,
          activeDeviceCode,
          connectionTarget,
        );
        if (!cancelled) {
          await queryClient.invalidateQueries({ queryKey });
        }
        return cancelled;
      } catch (e) {
        console.debug("[ManagedAuth] Failed to cancel device flow:", e);
        await queryClient.invalidateQueries({ queryKey });
        return false;
      }
    },
    [authProvider, connectionTarget, queryClient, queryKey],
  );

  const queueBackendCancellation = useCallback(
    (activeDeviceCode: string | null) => {
      const transition = flowTransitionRef.current.then(async () => {
        await cancelBackendFlow(activeDeviceCode);
      });
      flowTransitionRef.current = transition;
      return transition;
    },
    [cancelBackendFlow],
  );

  useEffect(() => {
    return () => {
      flowGenerationRef.current += 1;
      void cancelBackendFlow(activeDeviceCodeRef.current);
      activeDeviceCodeRef.current = null;
      stopPolling();
    };
  }, [cancelBackendFlow, stopPolling]);

  useEffect(() => {
    stopPolling();
    setPollingState("idle");
    setDeviceCode(null);
    setError(null);
  }, [connectionGeneration, stopPolling]);

  const startLoginMutation = useMutation({
    mutationFn: async ({
      targetAccountId,
      connectionGeneration: requestConnectionGeneration,
      loginMethod: method,
    }: LoginRequest) => ({
      response: await authApi.authStartLogin(
        authProvider,
        githubDomain,
        target,
        targetAccountId,
        method,
      ),
      connectionGeneration: requestConnectionGeneration,
    }),
    onSuccess: async (
      { response, connectionGeneration: requestGeneration },
      request,
    ) => {
      if (
        !isCurrentGeneration(requestGeneration) ||
        request.generation !== flowGenerationRef.current
      ) {
        void cancelBackendFlow(response.device_code);
        return;
      }
      activeDeviceCodeRef.current = response.device_code;
      setDeviceCode(response);
      setPollingState("polling");
      setError(null);

      // Browser login has no verification code; leave the clipboard untouched.
      const browserFlow = !response.user_code;
      if (!browserFlow) {
        try {
          await copyText(response.user_code);
        } catch (e) {
          console.debug("[ManagedAuth] Failed to copy user code:", e);
        }
      }
      if (
        !isCurrentGeneration(requestGeneration) ||
        request.generation !== flowGenerationRef.current
      ) {
        return;
      }

      // Device-code login can be completed in a browser, but only the local
      // target may launch one. Remote users retain the verification URL in UI.
      if (target.type === "local" && !response.browser_opened) {
        try {
          await settingsApi.openExternal(response.verification_uri);
        } catch (e) {
          console.debug("[ManagedAuth] Failed to open browser:", e);
        }
      }
      if (
        !isCurrentGeneration(requestGeneration) ||
        request.generation !== flowGenerationRef.current
      ) {
        return;
      }

      // Add a small buffer on top of GitHub's suggested interval to avoid
      // hitting slow_down responses too aggressively during device polling.
      // The browser flow only checks a local result, so it can poll quickly.
      const interval = browserFlow
        ? 1500
        : Math.max((response.interval || 5) + 3, 8) * 1000;
      let pollInFlight = false;
      const expiresAt = Date.now() + response.expires_in * 1000;

      const pollOnce = async () => {
        if (pollInFlight) return;
        if (
          !isCurrentGeneration(requestGeneration) ||
          request.generation !== flowGenerationRef.current
        ) {
          stopPolling();
          return;
        }
        if (Date.now() > expiresAt) {
          stopPolling();
          activeDeviceCodeRef.current = null;
          void cancelBackendFlow(response.device_code);
          flowGenerationRef.current += 1;
          setPollingState("error");
          setError(
            t("codexOauth.loginExpired", {
              defaultValue: "Login expired. Please try again.",
            }),
          );
          return;
        }

        try {
          pollInFlight = true;
          const newAccount = await authApi.authPollForAccount(
            authProvider,
            response.device_code,
            githubDomain,
            target,
          );
          if (
            !isCurrentGeneration(requestGeneration) ||
            request.generation !== flowGenerationRef.current
          ) {
            stopPolling();
            return;
          }
          if (newAccount) {
            stopPolling();
            activeDeviceCodeRef.current = null;
            flowGenerationRef.current += 1;
            const completionGeneration = flowGenerationRef.current;
            setPollingState("success");
            await refetchStatus();
            await queryClient.invalidateQueries({ queryKey });
            if (
              !isCurrentGeneration(requestGeneration) ||
              completionGeneration !== flowGenerationRef.current
            ) {
              return;
            }
            setPollingState("idle");
            setDeviceCode(null);
          }
        } catch (e) {
          if (
            !isCurrentGeneration(requestGeneration) ||
            request.generation !== flowGenerationRef.current
          ) {
            return;
          }
          const errorMessage = e instanceof Error ? e.message : String(e);
          if (
            !errorMessage.includes("pending") &&
            !errorMessage.includes("slow_down")
          ) {
            stopPolling();
            activeDeviceCodeRef.current = null;
            void cancelBackendFlow(response.device_code);
            flowGenerationRef.current += 1;
            setPollingState("error");
            setError(
              authProvider === "codex_oauth" &&
                errorMessage === CODEX_OAUTH_DUPLICATE_ACCOUNT_ERROR
                ? t("codexOauth.duplicateAccount", {
                    defaultValue: "该 ChatGPT 账号已添加，请直接使用现有账号。",
                  })
                : errorMessage,
            );
          }
        } finally {
          pollInFlight = false;
        }
      };

      pollingIntervalRef.current = setInterval(pollOnce, interval);
      pollingTimeoutRef.current = setTimeout(() => {
        if (
          !isCurrentGeneration(requestGeneration) ||
          request.generation !== flowGenerationRef.current
        ) {
          return;
        }
        stopPolling();
        activeDeviceCodeRef.current = null;
        void cancelBackendFlow(response.device_code);
        flowGenerationRef.current += 1;
        setPollingState("error");
        setError(
          t("codexOauth.loginExpired", {
            defaultValue: "Login expired. Please try again.",
          }),
        );
      }, response.expires_in * 1000);
      void pollOnce();
    },
    onError: (e, request) => {
      if (
        !isCurrentGeneration(request.connectionGeneration) ||
        request.generation !== flowGenerationRef.current
      ) {
        return;
      }
      setPollingState("error");
      setError(e instanceof Error ? e.message : String(e));
    },
  });

  const logoutMutation = useMutation({
    mutationFn: async () => {
      await authApi.authLogout(authProvider, target);
      return connectionGeneration;
    },
    onSuccess: async (generation) => {
      if (!isCurrentGeneration(generation)) return;
      setPollingState("idle");
      setDeviceCode(null);
      setError(null);
      queryClient.setQueryData(queryKey, {
        provider: authProvider,
        authenticated: false,
        default_account_id: null,
        accounts: [],
      });
      await queryClient.invalidateQueries({ queryKey });
    },
    onError: async (e) => {
      console.error("[ManagedAuth] Failed to logout:", e);
      setError(e instanceof Error ? e.message : String(e));
      await refetchStatus();
    },
    onSettled: async () => {
      if (authProvider === "codex_oauth") {
        await queryClient.invalidateQueries({
          queryKey: ["providers", "codex"],
        });
      }
    },
  });

  const removeAccountMutation = useMutation({
    mutationFn: async ({ accountId }: { accountId: string }) => {
      await authApi.authRemoveAccount(authProvider, accountId, target);
      return connectionGeneration;
    },
    onSuccess: async (generation) => {
      if (!isCurrentGeneration(generation)) return;
      setPollingState("idle");
      setDeviceCode(null);
      setError(null);
      // v4 的成功提示：移除账号后给一次确认（失败仍旧只弹错误）
      toast.success(
        t("managedAuth.accountRemoved", {
          defaultValue: "账号已移除",
        }),
      );
      await refetchStatus();
      await queryClient.invalidateQueries({ queryKey });
    },
    onError: async (e) => {
      console.error("[ManagedAuth] Failed to remove account:", e);
      setError(e instanceof Error ? e.message : String(e));
      // Account removal can succeed before provider unbinding fails.
      if (authProvider === "codex_oauth") await refetchStatus();
    },
    onSettled: async () => {
      if (authProvider === "codex_oauth") {
        await queryClient.invalidateQueries({
          queryKey: ["providers", "codex"],
        });
      }
    },
  });

  const setDefaultAccountMutation = useMutation({
    mutationFn: async ({ accountId }: { accountId: string }) => {
      await authApi.authSetDefaultAccount(authProvider, accountId, target);
      return connectionGeneration;
    },
    onSuccess: async (generation) => {
      if (!isCurrentGeneration(generation)) return;
      if (target.type === "local" && authProvider === "agy_oauth") {
        const running = await authApi.agyAccountIsRunning().catch(() => false);
        if (running) {
          toast.warning(t("authCenter.agy.switchedWhileRunning"));
        } else {
          toast.success(t("authCenter.agy.switched"));
        }
      }
      await refetchStatus();
      await queryClient.invalidateQueries({ queryKey });
    },
    onError: (e) => {
      console.error("[ManagedAuth] Failed to set default account:", e);
      setError(e instanceof Error ? e.message : String(e));
    },
  });

  const beginLogin = useCallback(
    (targetAccountId?: string) => {
      const previousDeviceCode = activeDeviceCodeRef.current;
      activeDeviceCodeRef.current = null;
      const generation = flowGenerationRef.current + 1;
      flowGenerationRef.current = generation;
      retryTargetAccountIdRef.current = targetAccountId;
      setPollingState("idle");
      setDeviceCode(null);
      setError(null);
      stopPolling();
      void queueBackendCancellation(previousDeviceCode).then(() => {
        if (generation !== flowGenerationRef.current) return;
        startLoginMutation.mutate({
          targetAccountId,
          generation,
          connectionGeneration,
          loginMethod,
        });
      });
    },
    [
      connectionGeneration,
      loginMethod,
      queueBackendCancellation,
      startLoginMutation,
      stopPolling,
    ],
  );

  const startAuth = useCallback(() => beginLogin(), [beginLogin]);

  const reauthAccount = useCallback(
    (accountId: string) => {
      beginLogin(accountId);
    },
    [beginLogin],
  );

  const retryAuth = useCallback(
    () => beginLogin(retryTargetAccountIdRef.current),
    [beginLogin],
  );

  const cancelAuth = useCallback(() => {
    flowGenerationRef.current += 1;
    const previousDeviceCode = activeDeviceCodeRef.current;
    activeDeviceCodeRef.current = null;
    retryTargetAccountIdRef.current = undefined;
    stopPolling();
    setPollingState("idle");
    setDeviceCode(null);
    setError(null);
    void queueBackendCancellation(previousDeviceCode);
  }, [queueBackendCancellation, stopPolling]);

  const logout = useCallback(() => {
    logoutMutation.mutate();
  }, [logoutMutation]);

  const removeAccount = useCallback(
    (accountId: string) => {
      removeAccountMutation.mutate({ accountId });
    },
    [removeAccountMutation],
  );

  const setDefaultAccount = useCallback(
    (accountId: string) => {
      setDefaultAccountMutation.mutate({ accountId });
    },
    [setDefaultAccountMutation],
  );

  const accounts = authStatus?.accounts ?? [];

  return {
    authStatus,
    isAuthSupported,
    isLoadingStatus:
      isAuthStatusLoading ||
      (target.type === "remote" && remoteHealthQuery.isLoading),
    isStatusSuccess: isAuthSupported && isAuthStatusSuccess,
    isStatusError: remoteHealthQuery.isError || isAuthStatusError,
    accounts,
    hasAnyAccount: accounts.length > 0,
    isAuthenticated: authStatus?.authenticated ?? false,
    defaultAccountId: authStatus?.default_account_id ?? null,
    migrationError: authStatus?.migration_error ?? null,
    pollingState,
    deviceCode,
    error,
    isPolling: pollingState === "polling",
    isAddingAccount: startLoginMutation.isPending || pollingState === "polling",
    isLoggingOut: logoutMutation.isPending,
    isRemovingAccount: removeAccountMutation.isPending,
    isSettingDefaultAccount: setDefaultAccountMutation.isPending,
    startAuth,
    addAccount: startAuth,
    canTargetedReauth,
    reauthAccount,
    retryAuth,
    cancelAuth,
    logout,
    removeAccount,
    setDefaultAccount,
    refetchStatus: refetchManagedAuthStatus,
  };
}
