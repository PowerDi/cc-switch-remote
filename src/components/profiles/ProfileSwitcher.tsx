import { useState } from "react";
import { useTranslation } from "react-i18next";
import {
  Check,
  ChevronsUpDown,
  FolderCog,
  FolderOpen,
  Plus,
  X,
} from "lucide-react";
import {
  Popover,
  PopoverContent,
  PopoverTrigger,
} from "@/components/ui/popover";
import {
  Command,
  CommandEmpty,
  CommandGroup,
  CommandInput,
  CommandItem,
  CommandList,
} from "@/components/ui/command";
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from "@/components/ui/dialog";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { cn } from "@/lib/utils";
import type { AppId } from "@/lib/api/types";
import {
  useApplyProfileMutation,
  useClearProfileMutation,
  useCreateProfileMutation,
  useProfilesQuery,
} from "@/lib/query/profiles";
import { ProfileManageDialog } from "./ProfileManageDialog";
import { APP_PROFILE_SCOPE, hasScopeSnapshot } from "./scope";
import type { CurrentProfileIds, ProfileScope } from "@/lib/api/profiles";
import type { ManagementTarget } from "@/lib/api/remote";
import {
  getManagementTargetKey,
  LOCAL_MANAGEMENT_TARGET,
} from "@/lib/managementTarget";
import { useTargetConnectionEpoch } from "@/hooks/useTargetConnectionEpoch";
import { useTargetCapability } from "@/hooks/useTargetCapability";

const CURRENT_ID_KEY: Record<ProfileScope, keyof CurrentProfileIds> = {
  claude: "claude",
  "claude-desktop": "claudeDesktop",
  codex: "codex",
};

interface ProfileSwitcherProps {
  activeApp: AppId;
  target?: ManagementTarget;
}

/**
 * 项目 Profile 切换器（header 左侧入口）
 *
 * 项目列表全应用共享（用户拥有的项目就那几个），但切换按分组进行：
 * Claude Code、Claude Desktop 与 Codex 各自指向自己的当前项目，
 * 只应用当前分组的快照。切换目标/连接/应用时丢弃旧对话框草稿和确认。
 * 与侧栏的应用列表（只切换查看的应用）语义不同。
 */
export function ProfileSwitcher({
  activeApp,
  target = LOCAL_MANAGEMENT_TARGET,
}: ProfileSwitcherProps) {
  const epoch = useTargetConnectionEpoch(target);
  const appSupportsProfiles = Boolean(APP_PROFILE_SCOPE[activeApp]);
  const helperSupportsProfiles = useTargetCapability(
    target,
    "profiles",
    appSupportsProfiles,
  );
  if (!appSupportsProfiles) return null;
  // 远端 helper 未实现项目命令时隐藏入口，而不是让点击报底层错误；
  // 本机始终可用（useTargetCapability 对本机直接返回 true）。
  if (!helperSupportsProfiles) return null;
  return (
    <ProfileSwitcherContent
      key={JSON.stringify([getManagementTargetKey(target), epoch, activeApp])}
      activeApp={activeApp}
      target={target}
    />
  );
}

function ProfileSwitcherContent({
  activeApp,
  target,
}: ProfileSwitcherProps & { target: ManagementTarget }) {
  const { t } = useTranslation();
  const [open, setOpen] = useState(false);
  const [isCreateOpen, setIsCreateOpen] = useState(false);
  const [isManageOpen, setIsManageOpen] = useState(false);
  const [newName, setNewName] = useState("");

  const { data } = useProfilesQuery(target);
  const applyMutation = useApplyProfileMutation(target);
  const clearMutation = useClearProfileMutation(target);
  const createMutation = useCreateProfileMutation(target);

  // Profile 仅作用于受支持的应用——在其他应用的标签页展示会误导用户
  // 以为当前应用也被切换了，因此只在有所属分组的应用页面渲染
  const scope = APP_PROFILE_SCOPE[activeApp];
  if (!scope) {
    return null;
  }

  const profiles = data?.profiles ?? [];
  const currentId = data?.currentIds?.[CURRENT_ID_KEY[scope]] ?? null;
  const currentProfile = profiles.find((p) => p.id === currentId);

  const handleApply = (id: string) => {
    setOpen(false);
    if (id !== currentId) {
      applyMutation.mutate({ id, scope });
    }
  };

  const closeCreateDialog = () => {
    setIsCreateOpen(false);
    setNewName("");
  };

  const handleCreate = () => {
    const name = newName.trim();
    if (!name) return;
    createMutation.mutate({ name, scope }, { onSuccess: closeCreateDialog });
  };

  return (
    <>
      <Popover open={open} onOpenChange={setOpen}>
        <PopoverTrigger asChild>
          <button
            type="button"
            role="combobox"
            aria-expanded={open}
            aria-label={t("profiles.switcherAriaLabel", {
              name: currentProfile?.name ?? t("profiles.none"),
            })}
            title={t(`profiles.switcherTooltip.${scope}`)}
            className={cn(
              "inline-flex h-8 items-center gap-1.5 rounded-lg px-2.5 text-sm font-medium transition-colors",
              "hover:bg-black/5 dark:hover:bg-white/5",
              currentProfile ? "text-fg-1" : "text-fg-2",
            )}
          >
            <FolderOpen className="h-4 w-4 shrink-0 opacity-70" />
            <span className="max-w-[9rem] truncate">
              {currentProfile?.name ?? t("profiles.none")}
            </span>
            <ChevronsUpDown className="h-3.5 w-3.5 shrink-0 opacity-50" />
          </button>
        </PopoverTrigger>
        <PopoverContent
          side="bottom"
          align="start"
          sideOffset={6}
          aria-label={t(`profiles.switcherTooltip.${scope}`)}
          className="z-[100] w-64 p-0"
        >
          <Command label={t("profiles.searchPlaceholder")}>
            <CommandInput placeholder={t("profiles.searchPlaceholder")} />
            <CommandList>
              <CommandEmpty>{t("profiles.empty")}</CommandEmpty>
              {profiles.length > 0 && (
                <CommandGroup>
                  {profiles.map((profile) => (
                    <CommandItem
                      key={profile.id}
                      value={profile.id}
                      keywords={[profile.name]}
                      onSelect={() => handleApply(profile.id)}
                    >
                      <Check
                        className={cn(
                          "mr-2 h-4 w-4 shrink-0",
                          currentId === profile.id
                            ? "opacity-100"
                            : "opacity-0",
                        )}
                      />
                      <span className="truncate">{profile.name}</span>
                      {!hasScopeSnapshot(profile, scope) && (
                        <span className="ml-auto shrink-0 pl-2 text-xs text-fg-2">
                          {t("profiles.noSnapshotForScope")}
                        </span>
                      )}
                    </CommandItem>
                  ))}
                </CommandGroup>
              )}
              <div className="mx-1 my-1 h-px bg-border" />
              <CommandGroup>
                <CommandItem
                  value="__create__"
                  keywords={[t("profiles.createFromCurrent")]}
                  onSelect={() => {
                    setOpen(false);
                    setIsCreateOpen(true);
                  }}
                >
                  <Plus className="mr-2 h-4 w-4 shrink-0" />
                  {t("profiles.createFromCurrent")}
                </CommandItem>
                {currentId && (
                  <CommandItem
                    value="__clear__"
                    keywords={[t("profiles.none")]}
                    onSelect={() => {
                      setOpen(false);
                      clearMutation.mutate(scope);
                    }}
                  >
                    <X className="mr-2 h-4 w-4 shrink-0" />
                    {t("profiles.none")}
                  </CommandItem>
                )}
                {profiles.length > 0 && (
                  <CommandItem
                    value="__manage__"
                    keywords={[t("profiles.manage")]}
                    onSelect={() => {
                      setOpen(false);
                      setIsManageOpen(true);
                    }}
                  >
                    <FolderCog className="mr-2 h-4 w-4 shrink-0" />
                    {t("profiles.manage")}
                  </CommandItem>
                )}
              </CommandGroup>
            </CommandList>
          </Command>
        </PopoverContent>
      </Popover>

      <Dialog
        open={isCreateOpen}
        onOpenChange={(open) => {
          if (!open) closeCreateDialog();
        }}
      >
        <DialogContent className="max-w-sm" zIndex="alert">
          <DialogHeader className="space-y-3 border-b-0 bg-transparent pb-0">
            <DialogTitle>{t("profiles.createFromCurrent")}</DialogTitle>
            <DialogDescription>
              {t(`profiles.createDescription.${scope}`)}
            </DialogDescription>
          </DialogHeader>
          <div className="px-6 pt-3">
            <Input
              value={newName}
              onChange={(e) => setNewName(e.target.value)}
              placeholder={t("profiles.namePlaceholder")}
              autoFocus
              onKeyDown={(e) => {
                if (e.key === "Enter") handleCreate();
              }}
            />
          </div>
          <DialogFooter className="flex gap-2 border-t-0 bg-transparent pt-2 sm:justify-end">
            <Button variant="outline" onClick={closeCreateDialog}>
              {t("common.cancel")}
            </Button>
            <Button
              onClick={handleCreate}
              disabled={!newName.trim() || createMutation.isPending}
            >
              {t("common.confirm")}
            </Button>
          </DialogFooter>
        </DialogContent>
      </Dialog>

      <ProfileManageDialog
        isOpen={isManageOpen}
        onClose={() => setIsManageOpen(false)}
        target={target}
      />
    </>
  );
}
