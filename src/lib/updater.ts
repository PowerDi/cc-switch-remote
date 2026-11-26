import { getVersion } from "@tauri-apps/api/app";
import { getGlobalProxyUrl } from "@/lib/api/globalProxy";
import {
  getPublishedIdentity,
  parseUpdateIdentity,
  type ReleaseIdentity,
} from "@/lib/releaseIdentity";

export type UpdateChannel = "stable" | "beta";

export interface UpdateInfo {
  currentVersion: string;
  /** Tauri/installer semver: retain this for update comparisons and dismissal persistence. */
  availableVersion: string;
  releaseIdentity?: ReleaseIdentity | null;
  notes?: string;
  pubDate?: string;
}

export interface CheckOptions {
  timeout?: number;
  channel?: UpdateChannel;
}

export async function getCurrentVersion(): Promise<string> {
  try {
    return await getVersion();
  } catch {
    return "";
  }
}

export async function checkForUpdate(
  opts: CheckOptions = {},
): Promise<
  { status: "up-to-date" } | { status: "available"; info: UpdateInfo }
> {
  // 动态引入，避免在未安装插件时导致打包期问题
  const { check } = await import("@tauri-apps/plugin-updater");

  const currentVersion = await getCurrentVersion();
  let proxy: string | undefined;
  try {
    proxy = (await getGlobalProxyUrl())?.trim() || undefined;
  } catch (error) {
    console.warn("[Updater] Failed to read global proxy URL", error);
  }

  const update = await check({
    timeout: opts.timeout ?? 30000,
    ...(proxy ? { proxy } : {}),
  } as any);

  if (!update) {
    return { status: "up-to-date" };
  }

  try {
    const availableVersion = update.version ?? "";
    const info: UpdateInfo = {
      currentVersion,
      availableVersion,
      releaseIdentity:
        parseUpdateIdentity(
          update.rawJson?.releaseIdentity,
          availableVersion,
        ) ?? getPublishedIdentity(availableVersion),
      notes: update.body,
      pubDate: update.date,
    };
    return { status: "available", info };
  } finally {
    // Installation uses the state-free Rust command's fresh check, not this resource.
    await update
      .close()
      .catch((error) =>
        console.warn("[Updater] Failed to release check resource", error),
      );
  }
}
