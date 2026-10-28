import {
  useMutation,
  useQuery,
  useQueryClient,
  keepPreviousData,
} from "@tanstack/react-query";
import {
  skillsApi,
  type SkillBackupEntry,
  type DiscoverableSkill,
  type ImportSkillSelection,
  type InstalledSkill,
  type SkillRepo,
  type SkillDiscoveryResult,
  type SkillUpdateCheckResult,
  type SkillUpdateInfo,
  type SkillsShSearchResult,
} from "@/lib/api/skills";
import type { AppId } from "@/lib/api/types";
import type { MutableRefObject } from "react";
import type { ManagementTarget } from "@/lib/api/remote";
import { mergeImportedSkills } from "@/hooks/useSkills.helpers";
import { readLocalCache, writeLocalCache } from "@/lib/localCache";
import { runSequentialBulkAction } from "@/lib/utils/sequentialBulkAction";
import {
  useLatestTarget,
  useTargetQueryIdentityReset,
} from "@/hooks/useTargetQueryIdentityReset";

const LOCAL_TARGET: ManagementTarget = { type: "local" };

const getTargetKey = (target: ManagementTarget) =>
  target.type === "remote" ? `remote:${target.profile.id}` : "local";

/**
 * 查询所有已安装的 Skills
 * 使用 staleTime: Infinity 实现首次进入使用缓存，只有刷新时才重新获取。
 * 不跨 query key 保留占位数据，避免切换管理目标时短暂显示另一目标的 Skill。
 */
export function useInstalledSkills(target: ManagementTarget = LOCAL_TARGET) {
  const targetKey = getTargetKey(target);
  const targetRef = useLatestTarget(target);
  const query = useQuery({
    queryKey: ["skills", "installed", targetKey],
    queryFn: () => skillsApi.getInstalled(targetRef.current),
    staleTime: Infinity,
  });
  useTargetQueryIdentityReset("skills", target, targetKey);
  return query;
}

export function useSkillBackups(target: ManagementTarget = LOCAL_TARGET) {
  const targetKey = getTargetKey(target);
  const targetRef = useLatestTarget(target);
  const query = useQuery({
    queryKey: ["skills", "backups", targetKey],
    queryFn: () => skillsApi.getBackups(targetRef.current),
    enabled: false,
  });
  useTargetQueryIdentityReset("skills", target, targetKey);
  return query;
}

export function useDeleteSkillBackup(target: ManagementTarget = LOCAL_TARGET) {
  const queryClient = useQueryClient();
  const targetKey = getTargetKey(target);
  return useMutation({
    mutationFn: (backupId: string) => skillsApi.deleteBackup(backupId, target),
    onSuccess: (_result, backupId) => {
      queryClient.setQueryData<SkillBackupEntry[]>(
        ["skills", "backups", targetKey],
        (oldData) => oldData?.filter((backup) => backup.backupId !== backupId),
      );
    },
    onSettled: () =>
      queryClient.invalidateQueries({
        queryKey: ["skills", "backups", targetKey],
      }),
  });
}

/**
 * 发现可安装的 Skills（从仓库获取）
 * 使用 staleTime: Infinity 实现首次进入使用缓存，只有刷新时才重新获取。
 * 不跨 query key 保留占位数据，避免切换管理目标时短暂显示另一目标的 Skill。
 */
// 发现要从 GitHub 下载每个仓库，很慢：上次的结果存在本地，打开时先显示，
// 每次启动只在后台重新拉一次（之后同一次运行里不再自动拉，手动刷新照常）。
// 本地缓存只对**本机**有效：远端每台机器目录不同，不能拿本机缓存冒充。
const DISCOVER_CACHE_KEY = "skills.discoverable.v1";
let discoverRevalidated = false;

const discoverableQuery = (
  target: ManagementTarget,
  targetRef: MutableRefObject<ManagementTarget>,
) => {
  const targetKey = getTargetKey(target);
  const isLocal = target.type === "local";
  return {
    queryKey: ["skills", "discoverable", targetKey],
    queryFn: async () => {
      const result = await skillsApi.discoverAvailable(targetRef.current);
      if (isLocal) {
        discoverRevalidated = true;
        writeLocalCache(DISCOVER_CACHE_KEY, result);
      }
      return result;
    },
    // Switching targets can reuse the same observer without a mount. Until
    // this process has refreshed local discovery, persisted data stays stale
    // so refetchOnMount is not the only trigger for that first local read.
    staleTime: isLocal && !discoverRevalidated ? 0 : Infinity,
    ...(isLocal
      ? {
          initialData: () =>
            readLocalCache<SkillDiscoveryResult>(DISCOVER_CACHE_KEY),
          // 本地缓存是旧数据：时间记成 0，配合 refetchOnMount 在后台刷新
          initialDataUpdatedAt: 0,
          refetchOnMount: () =>
            discoverRevalidated ? false : ("always" as const),
          placeholderData: (
            previous: SkillDiscoveryResult | undefined,
            previousQuery: { queryKey: readonly unknown[] } | undefined,
          ) => (previousQuery?.queryKey[2] === "local" ? previous : undefined),
        }
      : {}),
  };
};

const selectDiscoveredSkills = (result: SkillDiscoveryResult) => result.skills;
const selectDiscoveryFailures = (result: SkillDiscoveryResult) =>
  result.failures;

export function useDiscoverableSkills(target: ManagementTarget = LOCAL_TARGET) {
  const targetKey = getTargetKey(target);
  const targetRef = useLatestTarget(target);
  useTargetQueryIdentityReset("skills", target, targetKey);
  return useQuery({
    ...discoverableQuery(target, targetRef),
    select: selectDiscoveredSkills,
  });
}

/** 发现时没读到的仓库（和 useDiscoverableSkills 共用一次请求） */
export function useDiscoverableSkillsFailures(
  target: ManagementTarget = LOCAL_TARGET,
) {
  const targetKey = getTargetKey(target);
  const targetRef = useLatestTarget(target);
  useTargetQueryIdentityReset("skills", target, targetKey);
  return useQuery({
    ...discoverableQuery(target, targetRef),
    select: selectDiscoveryFailures,
  });
}

/**
 * 安装 Skill
 * 成功后直接更新缓存，不触发重新加载/刷新
 */
export function useInstallSkill(target: ManagementTarget = LOCAL_TARGET) {
  const queryClient = useQueryClient();
  const targetKey = getTargetKey(target);
  return useMutation({
    mutationFn: ({
      skill,
      currentApp,
    }: {
      skill: DiscoverableSkill;
      currentApp: AppId;
    }) => skillsApi.installUnified(skill, currentApp, target),
    onSuccess: (installedSkill) => {
      // v4 derives installed status from this target's installed list, not
      // from discovery metadata (which also carries repository failures).
      queryClient.setQueryData<InstalledSkill[]>(
        ["skills", "installed", targetKey],
        (oldData) => mergeImportedSkills(oldData, [installedSkill]),
      );
    },
    onSettled: () =>
      Promise.all([
        queryClient.invalidateQueries({
          queryKey: ["skills", "installed", targetKey],
        }),
        queryClient.invalidateQueries({
          queryKey: ["skills", "unmanaged", targetKey],
        }),
      ]),
  });
}

/**
 * 卸载 Skill
 * 成功后直接更新缓存，不触发重新加载/刷新
 */
export function useUninstallSkill(target: ManagementTarget = LOCAL_TARGET) {
  const queryClient = useQueryClient();
  const targetKey = getTargetKey(target);
  return useMutation({
    mutationFn: (id: string) => skillsApi.uninstallUnified(id, target),
    onSuccess: (_result, id) => {
      // 直接更新 installed 缓存，移除该 skill
      queryClient.setQueryData<InstalledSkill[]>(
        ["skills", "installed", targetKey],
        (oldData) => {
          if (!oldData) return oldData;
          return oldData.filter((s) => s.id !== id);
        },
      );

      // A completed update check may still contain this Skill. Remove it so
      // Update All cannot target an ID that was just uninstalled.
      queryClient.setQueryData<SkillUpdateCheckResult>(
        ["skills", "updates", targetKey],
        (oldData) =>
          oldData && {
            ...oldData,
            updates: oldData.updates.filter((update) => update.id !== id),
          },
      );
    },
    onSettled: () =>
      Promise.all([
        queryClient.invalidateQueries({
          queryKey: ["skills", "backups", targetKey],
        }),
        queryClient.invalidateQueries({
          queryKey: ["skills", "unmanaged", targetKey],
        }),
      ]),
  });
}

export function useRestoreSkillBackup(target: ManagementTarget = LOCAL_TARGET) {
  const queryClient = useQueryClient();
  const targetKey = getTargetKey(target);
  return useMutation({
    mutationFn: ({
      backupId,
      currentApp,
    }: {
      backupId: string;
      currentApp: AppId;
    }) => skillsApi.restoreBackup(backupId, currentApp, target),
    onSettled: () =>
      Promise.all([
        queryClient.invalidateQueries({
          queryKey: ["skills", "installed", targetKey],
        }),
        queryClient.invalidateQueries({
          queryKey: ["skills", "backups", targetKey],
        }),
      ]),
  });
}

/**
 * 切换 Skill 在特定应用的启用状态
 */
export function useToggleSkillApp(target: ManagementTarget = LOCAL_TARGET) {
  const queryClient = useQueryClient();
  const targetKey = getTargetKey(target);
  return useMutation({
    mutationFn: ({
      id,
      app,
      enabled,
    }: {
      id: string;
      app: AppId;
      enabled: boolean;
    }) => skillsApi.toggleApp(id, app, enabled, target),
    // 乐观更新：点了格子立刻翻过来，不等写完再刷新；失败时回滚
    onMutate: async ({ id, app, enabled }) => {
      const key = ["skills", "installed", targetKey];
      await queryClient.cancelQueries({ queryKey: key });
      const previous = queryClient.getQueryData<InstalledSkill[]>(key);
      if (previous) {
        queryClient.setQueryData<InstalledSkill[]>(
          key,
          previous.map((skill) =>
            skill.id === id
              ? { ...skill, apps: { ...skill.apps, [app]: enabled } }
              : skill,
          ),
        );
      }
      return { previous };
    },
    onError: (_error, _vars, context) => {
      if (context?.previous) {
        queryClient.setQueryData(
          ["skills", "installed", targetKey],
          context.previous,
        );
      }
    },
    onSuccess: () =>
      queryClient.invalidateQueries({
        queryKey: ["skills", "installed", targetKey],
      }),
  });
}

/** Toggle multiple Skills serially because each operation writes app files. */
export function useBulkToggleSkillApp(target: ManagementTarget = LOCAL_TARGET) {
  const queryClient = useQueryClient();
  const targetKey = getTargetKey(target);
  return useMutation({
    mutationFn: ({
      ids,
      app,
      enabled,
    }: {
      ids: string[];
      app: AppId;
      enabled: boolean;
    }) =>
      runSequentialBulkAction(ids, (id) =>
        skillsApi.toggleApp(id, app, enabled, target),
      ),
    onSettled: () =>
      queryClient.invalidateQueries({
        queryKey: ["skills", "installed", targetKey],
      }),
  });
}

/**
 * 扫描未管理的 Skills
 *
 * - 传 { enabled: true }（Skill 面板挂载时）会在进入页面时自动静默扫描一次，
 *   30s 内复用结果，避免来回切页时重复磁盘 IO。
 * - 默认 enabled: false：仅订阅共享缓存（如顶栏「导入」按钮的绿点提示），
 *   不主动触发扫描。两者共用同一 queryKey，面板扫描完成后绿点会自动亮起。
 */
export function useScanUnmanagedSkills(
  target: ManagementTarget = LOCAL_TARGET,
  options?: { enabled?: boolean },
) {
  const targetKey = getTargetKey(target);
  const targetRef = useLatestTarget(target);
  const query = useQuery({
    queryKey: ["skills", "unmanaged", targetKey],
    queryFn: () => skillsApi.scanUnmanaged(targetRef.current),
    enabled: options?.enabled ?? false,
    staleTime: 30 * 1000,
  });
  useTargetQueryIdentityReset("skills", target, targetKey);
  return query;
}

/**
 * 从应用目录导入 Skills
 * 成功后直接更新缓存，不触发重新加载/刷新
 */
export function useImportSkillsFromApps(
  target: ManagementTarget = LOCAL_TARGET,
) {
  const queryClient = useQueryClient();
  const targetKey = getTargetKey(target);
  return useMutation({
    mutationFn: (imports: ImportSkillSelection[]) =>
      skillsApi.importFromApps(imports, target),
    onSuccess: (importedSkills) => {
      // 直接更新 installed 缓存
      queryClient.setQueryData<InstalledSkill[]>(
        ["skills", "installed", targetKey],
        (oldData) => mergeImportedSkills(oldData, importedSkills),
      );
    },
    // Import may persist Skills or auto-discovered repositories before a
    // later item fails, so refresh every affected authoritative collection.
    // 只等导入弹窗关心的两个列表：mutation 要等 onSettled 返回的 Promise
    // 才结束，「发现」重拉要从 GitHub 下载仓库，等它会让弹窗一直锁着（#7994）
    onSettled: () => {
      void queryClient.invalidateQueries({
        queryKey: ["skills", "repos", targetKey],
      });
      void queryClient.invalidateQueries({
        queryKey: ["skills", "discoverable", targetKey],
      });
      return Promise.all([
        queryClient.invalidateQueries({
          queryKey: ["skills", "installed", targetKey],
        }),
        queryClient.invalidateQueries({
          queryKey: ["skills", "unmanaged", targetKey],
        }),
      ]);
    },
  });
}

/**
 * 获取仓库列表
 */
export function useSkillRepos(target: ManagementTarget = LOCAL_TARGET) {
  const targetKey = getTargetKey(target);
  const targetRef = useLatestTarget(target);
  const query = useQuery({
    queryKey: ["skills", "repos", targetKey],
    queryFn: () => skillsApi.getRepos(targetRef.current),
  });
  useTargetQueryIdentityReset("skills", target, targetKey);
  return query;
}

/**
 * 添加仓库
 */
export function useAddSkillRepo(target: ManagementTarget = LOCAL_TARGET) {
  const queryClient = useQueryClient();
  const targetKey = getTargetKey(target);
  return useMutation({
    mutationFn: (repo: SkillRepo) => skillsApi.addRepo(repo, target),
    onSuccess: () => {
      queryClient.invalidateQueries({
        queryKey: ["skills", "repos", targetKey],
      });
      queryClient.invalidateQueries({
        queryKey: ["skills", "discoverable", targetKey],
      });
    },
  });
}

/**
 * 删除仓库
 */
export function useRemoveSkillRepo(target: ManagementTarget = LOCAL_TARGET) {
  const queryClient = useQueryClient();
  const targetKey = getTargetKey(target);
  return useMutation({
    mutationFn: ({ owner, name }: { owner: string; name: string }) =>
      skillsApi.removeRepo(owner, name, target),
    onSuccess: () => {
      queryClient.invalidateQueries({
        queryKey: ["skills", "repos", targetKey],
      });
      queryClient.invalidateQueries({
        queryKey: ["skills", "discoverable", targetKey],
      });
    },
  });
}

/**
 * 从 ZIP 文件安装 Skills
 * 成功后直接更新缓存，不触发重新加载/刷新
 */
export function useInstallSkillsFromZip() {
  const queryClient = useQueryClient();
  return useMutation({
    mutationFn: ({
      filePath,
      currentApp,
    }: {
      filePath: string;
      currentApp: AppId;
    }) => skillsApi.installFromZip(filePath, currentApp),
    onSuccess: (result) => {
      queryClient.setQueryData<InstalledSkill[]>(
        ["skills", "installed", "local"],
        (oldData) => mergeImportedSkills(oldData, result.installed),
      );
    },
    onSettled: () =>
      Promise.all([
        queryClient.invalidateQueries({
          queryKey: ["skills", "installed", "local"],
        }),
        queryClient.invalidateQueries({
          queryKey: ["skills", "unmanaged", "local"],
        }),
      ]),
  });
}

// ========== 更新检测 ==========

/**
 * 检查 Skills 更新（手动触发）；结果里带着没读到的仓库
 */
export function useCheckSkillUpdates(target: ManagementTarget = LOCAL_TARGET) {
  const targetKey = getTargetKey(target);
  const targetRef = useLatestTarget(target);
  const query = useQuery({
    queryKey: ["skills", "updates", targetKey],
    queryFn: () => skillsApi.checkUpdates(targetRef.current),
    enabled: false,
    staleTime: 5 * 60 * 1000,
  });
  useTargetQueryIdentityReset("skills", target, targetKey);
  return query;
}

/**
 * 更新单个 Skill
 */
export function useUpdateSkill(target: ManagementTarget = LOCAL_TARGET) {
  const queryClient = useQueryClient();
  const targetKey = getTargetKey(target);
  return useMutation({
    mutationFn: (id: string) => skillsApi.updateSkill(id, target),
    onSuccess: (updatedSkill) => {
      queryClient.setQueryData<InstalledSkill[]>(
        ["skills", "installed", targetKey],
        (oldData) => {
          if (!oldData) return [updatedSkill];
          return oldData.map((s) =>
            s.id === updatedSkill.id ? updatedSkill : s,
          );
        },
      );
      queryClient.setQueryData<SkillUpdateCheckResult>(
        ["skills", "updates", targetKey],
        (oldData) => {
          if (!oldData) return oldData;
          return {
            ...oldData,
            updates: oldData.updates.filter((u) => u.id !== updatedSkill.id),
          };
        },
      );
    },
    onSettled: () =>
      queryClient.invalidateQueries({
        queryKey: ["skills", "backups", targetKey],
      }),
  });
}

// ========== skills.sh 搜索 ==========

/**
 * 搜索 skills.sh 公共目录
 * 使用 300ms staleTime 和 keepPreviousData 实现平滑搜索体验
 */
export function useSearchSkillsSh(
  query: string,
  limit: number,
  offset: number,
) {
  return useQuery({
    queryKey: ["skills", "skillssh", query, limit, offset],
    queryFn: () => skillsApi.searchSkillsSh(query, limit, offset),
    enabled: query.length >= 2,
    staleTime: 5 * 60 * 1000,
    placeholderData: keepPreviousData,
  });
}

// ========== 辅助类型 ==========

export type {
  InstalledSkill,
  DiscoverableSkill,
  ImportSkillSelection,
  SkillBackupEntry,
  SkillUpdateInfo,
  SkillsShSearchResult,
  AppId,
};

/**
 * 立即重新同步：按开关和当前同步方式把 Skill 重新投影到各应用目录
 */
export function useResyncSkillsToApps() {
  const queryClient = useQueryClient();
  return useMutation({
    mutationFn: () => skillsApi.resyncToApps(),
    onSettled: () =>
      queryClient.invalidateQueries({ queryKey: ["skills", "installed"] }),
  });
}

/**
 * CC Switch 目录下放 Skill 主副本的真实路径（改过配置目录就是改后的）
 */
export function useCcSwitchSkillsDir(enabled = true) {
  return useQuery({
    queryKey: ["skills", "ccSwitchDir"],
    queryFn: () => skillsApi.getCcSwitchSkillsDir(),
    enabled,
    staleTime: Infinity,
  });
}
