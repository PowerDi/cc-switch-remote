import { useMutation, type MutateOptions } from "@tanstack/react-query";
import type { ManagementTarget } from "@/lib/api/remote";
import { useTargetConnectionEpoch } from "./useTargetConnectionEpoch";

export interface TargetMutationScope {
  target: ManagementTarget;
  epoch: number | undefined;
}

interface TargetMutationOptions<TData, TVariables> {
  mutationFn: (
    variables: TVariables,
    scope: TargetMutationScope,
  ) => Promise<TData>;
  onSuccess?: (
    data: TData,
    variables: TVariables,
    scope: TargetMutationScope,
  ) => Promise<unknown> | unknown;
  onError?: (
    error: Error,
    variables: TVariables,
    scope: TargetMutationScope,
  ) => Promise<unknown> | unknown;
}

type BoundMutation<TData, TVariables> = {
  input: TVariables;
  scope: TargetMutationScope;
  handlers: TargetMutationOptions<TData, TVariables>;
};

/** Bind execution AND completion to the target at submission, not the target
 * a mutable Query observer happens to display when an async operation finishes.
 * Target/handlers stay in memory; no credentials enter query/mutation keys.
 * This adapter deliberately adds no optimistic writes or automatic retries.
 */
export function useTargetMutation<TData, TVariables>(
  target: ManagementTarget,
  options: TargetMutationOptions<TData, TVariables>,
) {
  const epoch = useTargetConnectionEpoch(target);
  const mutation = useMutation<
    TData,
    Error,
    BoundMutation<TData, TVariables>,
    undefined
  >({
    retry: false,
    mutationFn: ({ input, scope, handlers }) =>
      handlers.mutationFn(input, scope),
    onSuccess: (data, { input, scope, handlers }) =>
      handlers.onSuccess?.(data, input, scope),
    onError: (error, { input, scope, handlers }) =>
      handlers.onError?.(error, input, scope),
  });
  const bind = (input: TVariables): BoundMutation<TData, TVariables> => ({
    input,
    scope: { target: structuredClone(target), epoch },
    handlers: options,
  });
  const callbacksFor = (
    callbacks?: MutateOptions<TData, Error, TVariables, undefined>,
  ): MutateOptions<
    TData,
    Error,
    BoundMutation<TData, TVariables>,
    undefined
  > => ({
    onSuccess: (data, { input }, result, context) =>
      callbacks?.onSuccess?.(data, input, result, context),
    onError: (error, { input }, result, context) =>
      callbacks?.onError?.(error, input, result, context),
    onSettled: (data, error, { input }, result, context) =>
      callbacks?.onSettled?.(data, error, input, result, context),
  });

  return {
    ...mutation,
    variables: mutation.variables?.input,
    mutate: (
      input: TVariables,
      callbacks?: MutateOptions<TData, Error, TVariables, undefined>,
    ) => mutation.mutate(bind(input), callbacksFor(callbacks)),
    mutateAsync: (
      input: TVariables,
      callbacks?: MutateOptions<TData, Error, TVariables, undefined>,
    ) => mutation.mutateAsync(bind(input), callbacksFor(callbacks)),
  };
}
