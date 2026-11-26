/** 本 fork 的发布页。
 *
 * 运行时所有「版本详情 / 更新说明」入口都指向这里：条目内容来自上游基线，但下载
 * 与发布记录属于本 fork，不能把用户送到上游仓库或上游官网。
 */
import metadata from "../../release-identity.json";
import {
  getBuildIdentity,
  getPublishedIdentity,
  isUnreleasedBuild,
  type ReleaseIdentity,
} from "@/lib/releaseIdentity";

export const FORK_REPOSITORY_URL = `https://github.com/${metadata.repository}`;
export const FORK_RELEASES_URL = `${FORK_REPOSITORY_URL}/releases`;

export function releasePageUrl(identity: ReleaseIdentity | null): string {
  return identity
    ? `${FORK_RELEASES_URL}/tag/${encodeURIComponent(identity.releaseTag)}`
    : FORK_RELEASES_URL;
}

export function currentReleasePageUrl(packageVersion?: string | null): string {
  return releasePageUrl(
    isUnreleasedBuild(packageVersion) ? null : getBuildIdentity(packageVersion),
  );
}

export function updateReleasePageUrl(
  packageVersion: string,
  identity?: ReleaseIdentity | null,
): string {
  return releasePageUrl(identity ?? getPublishedIdentity(packageVersion));
}
