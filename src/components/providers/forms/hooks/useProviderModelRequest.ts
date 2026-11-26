import { useLayoutEffect, useRef, useState } from "react";
import type { ManagementTarget } from "@/lib/api/remote";
import type { FetchedModel } from "@/lib/api/model-fetch";

export function useProviderModelRequest({
  app,
  providerId,
  target,
  baseUrl,
  apiKey,
  headers,
}: {
  app: string;
  providerId?: string;
  target?: ManagementTarget;
  baseUrl: string;
  apiKey: string;
  headers?: Record<string, string>;
}) {
  const [fetchedModels, setFetchedModels] = useState<FetchedModel[]>([]);
  const [isFetchingModels, setIsFetchingModels] = useState(false);
  const generation = useRef(0);
  const profile = target?.type === "remote" ? target.profile : undefined;
  const password =
    target?.type === "remote" ? target.secret?.password : undefined;
  const authMethod = profile?.authMethod.type;
  const keyPath =
    profile?.authMethod.type === "keyFile"
      ? profile.authMethod.path
      : undefined;
  const headerValues = headers
    ? JSON.stringify(Object.entries(headers).sort())
    : undefined;

  useLayoutEffect(() => {
    setFetchedModels((previous) => (previous.length ? [] : previous));
    setIsFetchingModels(false);
    return () => {
      generation.current += 1;
    };
  }, [
    app,
    providerId,
    baseUrl,
    apiKey,
    headerValues,
    profile?.id,
    profile?.host,
    profile?.port,
    profile?.username,
    profile?.helperPath,
    authMethod,
    keyPath,
    password,
  ]);

  const run = async (
    request: () => Promise<FetchedModel[]>,
    onSuccess: (models: FetchedModel[]) => void,
    onError: (error: unknown) => void,
  ) => {
    const current = ++generation.current;
    setFetchedModels((previous) => (previous.length ? [] : previous));
    setIsFetchingModels(true);
    try {
      const models = await request();
      if (current === generation.current) onSuccess(models);
    } catch (error) {
      if (current === generation.current) onError(error);
    } finally {
      if (current === generation.current) setIsFetchingModels(false);
    }
  };

  return { fetchedModels, setFetchedModels, isFetchingModels, run };
}
