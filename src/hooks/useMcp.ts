import { useRef } from "react";
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { mcpApi } from "@/lib/api/mcp";
import type { McpServer, McpServersMap } from "@/types";
import type { AppId } from "@/lib/api/types";
import type { ManagementTarget } from "@/lib/api/remote";
import { runSequentialBulkAction } from "@/lib/utils/sequentialBulkAction";
import { useTargetQueryIdentityReset } from "@/hooks/useTargetQueryIdentityReset";

const LOCAL_TARGET: ManagementTarget = { type: "local" };

const getTargetKey = (target: ManagementTarget) =>
  target.type === "remote" ? `remote:${target.profile.id}` : "local";

/** 列表按管理目标分槽：远端页面不能读到本机同名 server 的缓存。 */
const mcpAllKey = (target: ManagementTarget) =>
  ["mcp", "all", getTargetKey(target)] as const;

/**
 * 查询所有 MCP 服务器（统一管理）
 */
export function useAllMcpServers(target: ManagementTarget = LOCAL_TARGET) {
  const targetKey = getTargetKey(target);
  // 同一个 profile id 换了主机/凭据时要丢弃旧缓存（否则 C8 会把旧结果还给新连接）。
  // reset 触发的重新拉取可能仍带着上一轮的 queryFn 闭包，所以目标从 ref 里读最新值，
  // 避免同一个 key 下用旧主机的结果回答新连接。
  useTargetQueryIdentityReset("mcp", target, targetKey);
  const targetRef = useRef(target);
  targetRef.current = target;
  return useQuery({
    queryKey: mcpAllKey(target),
    queryFn: () => mcpApi.getAllServers(targetRef.current),
  });
}

/**
 * 添加或更新 MCP 服务器
 */
/** 编辑页保存用的 mutation key：页面据此在保存进行中锁住导航 */
export const MCP_UPSERT_MUTATION_KEY = ["mcp", "upsert"] as const;

export function useUpsertMcpServer(target: ManagementTarget = LOCAL_TARGET) {
  const queryClient = useQueryClient();
  return useMutation({
    mutationKey: MCP_UPSERT_MUTATION_KEY,
    mutationFn: (server: McpServer) =>
      mcpApi.upsertUnifiedServer(server, target),
    // The database is updated before live configs are synchronized, so an
    // error can still leave a persisted change that the list must reflect.
    onSettled: () =>
      queryClient.invalidateQueries({ queryKey: mcpAllKey(target) }),
  });
}

/** Toggle multiple MCP servers serially to avoid lost whole-file writes. */
export function useBulkToggleMcpApp(target: ManagementTarget = LOCAL_TARGET) {
  const queryClient = useQueryClient();
  return useMutation({
    mutationFn: ({
      serverIds,
      app,
      enabled,
    }: {
      serverIds: string[];
      app: AppId;
      enabled: boolean;
    }) =>
      runSequentialBulkAction(serverIds, (serverId) =>
        mcpApi.toggleApp(serverId, app, enabled, target),
      ),
    onSettled: () =>
      queryClient.invalidateQueries({ queryKey: mcpAllKey(target) }),
  });
}

/**
 * 切换 MCP 服务器在特定应用的启用状态
 */
export function useToggleMcpApp(target: ManagementTarget = LOCAL_TARGET) {
  const queryClient = useQueryClient();
  const key = mcpAllKey(target);
  return useMutation({
    mutationFn: ({
      serverId,
      app,
      enabled,
    }: {
      serverId: string;
      app: AppId;
      enabled: boolean;
    }) => mcpApi.toggleApp(serverId, app, enabled, target),
    // 乐观更新：点了格子立刻翻过来，不等写完再刷新；失败时回滚
    onMutate: async ({ serverId, app, enabled }) => {
      await queryClient.cancelQueries({ queryKey: key });
      const previous = queryClient.getQueryData<McpServersMap>(key);
      const server = previous?.[serverId];
      if (previous && server) {
        queryClient.setQueryData<McpServersMap>(key, {
          ...previous,
          [serverId]: { ...server, apps: { ...server.apps, [app]: enabled } },
        });
      }
      return { previous };
    },
    onError: (_error, _vars, context) => {
      if (context?.previous) {
        queryClient.setQueryData(key, context.previous);
      }
    },
    // The backend may update the database before a live-config write fails.
    // Always refresh so the UI reflects the persisted state after an error.
    onSettled: () => queryClient.invalidateQueries({ queryKey: key }),
  });
}

/**
 * 删除 MCP 服务器
 */
export function useDeleteMcpServer(target: ManagementTarget = LOCAL_TARGET) {
  const queryClient = useQueryClient();
  return useMutation({
    mutationFn: (id: string) => mcpApi.deleteUnifiedServer(id, target),
    // Deletion reaches the database before live-config cleanup, so refresh
    // after both success and failure to avoid operating on a removed entry.
    onSettled: () =>
      queryClient.invalidateQueries({ queryKey: mcpAllKey(target) }),
  });
}

/**
 * 按这里的开关把 MCP 重新写进各应用的配置（不传 apps＝全部受管应用），逐应用返回结果
 *
 * 注意：这条只作用于本机（`resync_mcp_to_apps` 没有远端命令）；远端页面
 * 由 MCP 能力门控决定是否暴露，不要把它当成远端操作。
 */
export function useResyncMcpToApps() {
  const queryClient = useQueryClient();
  return useMutation({
    mutationFn: (apps?: AppId[]) => mcpApi.resyncToApps(apps),
    onSettled: () =>
      queryClient.invalidateQueries({ queryKey: ["mcp", "all"] }),
  });
}

/**
 * 从所有应用导入 MCP 服务器
 */
export function useImportMcpFromApps(target: ManagementTarget = LOCAL_TARGET) {
  const queryClient = useQueryClient();
  return useMutation({
    mutationFn: () => mcpApi.importFromApps(target),
    // 后端是 best-effort 导入：部分应用失败会返回错误，但其余应用的
    // 服务器已经入库，失败时也要刷新列表。
    onSettled: () =>
      queryClient.invalidateQueries({ queryKey: mcpAllKey(target) }),
  });
}
