import { useQuery, useMutation, useQueryClient } from "@tanstack/react-query";
import { backupsApi } from "@/lib/api";
import type { ManagementTarget } from "@/lib/api";
import {
  getManagementTargetKey,
  LOCAL_MANAGEMENT_TARGET,
} from "@/lib/managementTarget";

const BACKUP_LOCATIONS_KEY = ["backup-locations"];

export function useBackupManager(
  target: ManagementTarget = LOCAL_MANAGEMENT_TARGET,
) {
  const queryClient = useQueryClient();
  const targetKey = getManagementTargetKey(target);

  const {
    data: backups = [],
    isLoading,
    refetch,
  } = useQuery({
    queryKey: ["db-backups", targetKey],
    queryFn: () => backupsApi.listDbBackups(target),
  });

  // 数据库备份增删也会改变「其他备份」总览里数据库那一行
  const refreshAll = async () => {
    await refetch();
    await queryClient.invalidateQueries({ queryKey: BACKUP_LOCATIONS_KEY });
  };

  const createMutation = useMutation({
    mutationFn: () => backupsApi.createDbBackup(target),
    onSuccess: refreshAll,
  });

  const restoreMutation = useMutation({
    mutationFn: (filename: string) =>
      backupsApi.restoreDbBackup(filename, target),
    onSuccess: async () => {
      await queryClient.invalidateQueries({
        predicate: (query) => query.queryKey.includes(targetKey),
      });
      await refetch();
    },
  });

  const renameMutation = useMutation({
    mutationFn: ({
      oldFilename,
      newName,
    }: {
      oldFilename: string;
      newName: string;
    }) => backupsApi.renameDbBackup(oldFilename, newName, target),
    onSuccess: () => refetch(),
  });

  const deleteMutation = useMutation({
    mutationFn: (filename: string) =>
      backupsApi.deleteDbBackup(filename, target),
    onSuccess: refreshAll,
  });

  return {
    backups,
    isLoading,
    create: createMutation.mutateAsync,
    isCreating: createMutation.isPending,
    restore: restoreMutation.mutateAsync,
    isRestoring: restoreMutation.isPending,
    rename: renameMutation.mutateAsync,
    isRenaming: renameMutation.isPending,
    remove: deleteMutation.mutateAsync,
    isDeleting: deleteMutation.isPending,
  };
}

export function useBackupLocations() {
  const queryClient = useQueryClient();

  const query = useQuery({
    queryKey: BACKUP_LOCATIONS_KEY,
    queryFn: () => backupsApi.listBackupLocations(),
  });

  const deleteMutation = useMutation({
    mutationFn: (id: string) => backupsApi.deleteBackupLocation(id),
    onSuccess: async (_freed, id) => {
      await queryClient.invalidateQueries({ queryKey: BACKUP_LOCATIONS_KEY });
      // Skills 页的备份列表与这里删的是同一个目录
      if (id === "skills") {
        await queryClient.invalidateQueries({
          queryKey: ["skills", "backups"],
        });
      }
    },
  });

  return {
    locations: query.data ?? [],
    isLoading: query.isLoading,
    isError: query.isError,
    remove: deleteMutation.mutateAsync,
    isDeleting: deleteMutation.isPending,
  };
}
