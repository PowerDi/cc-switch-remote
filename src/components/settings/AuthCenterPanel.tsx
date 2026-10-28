import { useEffect, useRef, useState } from "react";
import { useTranslation } from "react-i18next";
import { CopilotAuthSection } from "@/components/providers/forms/CopilotAuthSection";
import { CodexOAuthSection } from "@/components/providers/forms/CodexOAuthSection";
import { XaiOAuthSection } from "@/components/providers/forms/XaiOAuthSection";
import type { ManagementTarget } from "@/lib/api";
import { LOCAL_MANAGEMENT_TARGET } from "@/lib/managementTarget";

import { AgyOAuthSection } from "@/components/providers/forms/AgyOAuthSection";
import { ClaudeOfficialSection } from "@/components/providers/forms/ClaudeOfficialSection";
import { KimiAccountLogin } from "@/components/providers/KimiAccountLogin";
import { isMac } from "@/lib/platform";
import type { AuthCenterTarget } from "@/lib/api";

interface AuthCenterPanelProps {
  authScrollTarget?: AuthCenterTarget | null;
  target?: ManagementTarget;
  /**
   * 页头没有「?」说明时（供应商表单里打开的全屏「授权中心」）在最上面写一行说明；
   * 侧栏「授权中心」页的页头已经有了，就不再显示。
   */
  showIntro?: boolean;
  /** 三组账号里任意一组在进行托管认证交互：调用方据此锁住目标切换 */
  onBusyChange?: (busy: boolean) => void;
}

/**
 * 授权中心：Claude 官方账号、GitHub Copilot、ChatGPT、xAI、Kimi Code，一组一张卡片；
 * macOS 上另有 Antigravity 一组（切 agy 的官方登录，目前只实现了 macOS 钥匙串）。
 * 侧栏的「授权中心」页和供应商表单里「管理账号」打开的全屏页共用。
 */
export function AuthCenterPanel({
  authScrollTarget,
  target = LOCAL_MANAGEMENT_TARGET,
  showIntro = true,
  onBusyChange,
}: AuthCenterPanelProps) {
  const { t } = useTranslation();
  const [copilotBusy, setCopilotBusy] = useState(false);
  const [codexBusy, setCodexBusy] = useState(false);
  const [xaiBusy, setXaiBusy] = useState(false);
  const busy = copilotBusy || codexBusy || xaiBusy;
  useEffect(() => {
    onBusyChange?.(busy);
    return () => onBusyChange?.(false);
  }, [busy, onBusyChange]);
  const claudeOfficialSectionRef = useRef<HTMLDivElement | null>(null);
  const copilotSectionRef = useRef<HTMLDivElement | null>(null);
  const codexOauthSectionRef = useRef<HTMLDivElement | null>(null);
  const xaiOauthSectionRef = useRef<HTMLDivElement | null>(null);
  const agyOauthSectionRef = useRef<HTMLDivElement | null>(null);
  const kimiOauthSectionRef = useRef<HTMLDivElement | null>(null);
  const showAgy = target.type === "local" && isMac();

  useEffect(() => {
    if (!authScrollTarget) return;

    const sectionRef =
      authScrollTarget === "kimi_oauth"
        ? kimiOauthSectionRef
        : authScrollTarget === "claude_official"
          ? claudeOfficialSectionRef
          : authScrollTarget === "github_copilot"
            ? copilotSectionRef
            : authScrollTarget === "codex_oauth"
              ? codexOauthSectionRef
              : authScrollTarget === "agy_oauth"
                ? agyOauthSectionRef
                : xaiOauthSectionRef;

    const frame = requestAnimationFrame(() => {
      const prefersReducedMotion = window.matchMedia(
        "(prefers-reduced-motion: reduce)",
      ).matches;

      sectionRef.current?.scrollIntoView({
        behavior: prefersReducedMotion ? "auto" : "smooth",
        block: "start",
      });
    });

    return () => cancelAnimationFrame(frame);
  }, [authScrollTarget]);

  return (
    <div className="flex flex-col gap-3">
      {showIntro && (
        <p className="m-0 max-w-[700px] text-caption text-fg-2">
          {t("settings.authCenter.description")}
        </p>
      )}
      {target.type === "local" && (
        <div ref={claudeOfficialSectionRef} className="scroll-mt-4">
          <ClaudeOfficialSection helpSide="bottom" />
        </div>
      )}
      <div ref={copilotSectionRef} className="scroll-mt-4">
        <CopilotAuthSection target={target} onBusyChange={setCopilotBusy} />
      </div>
      <div ref={codexOauthSectionRef} className="scroll-mt-4">
        <CodexOAuthSection
          showAccountQuota
          target={target}
          onBusyChange={setCodexBusy}
        />
      </div>
      <div ref={xaiOauthSectionRef} className="scroll-mt-4">
        <XaiOAuthSection
          mode="manage"
          helpSide="top"
          target={target}
          onBusyChange={setXaiBusy}
        />
      </div>
      {target.type === "local" && (
        <div ref={kimiOauthSectionRef} className="scroll-mt-4">
          <KimiAccountLogin helpSide={showAgy ? "bottom" : "top"} />
        </div>
      )}
      {showAgy && (
        <div ref={agyOauthSectionRef} className="scroll-mt-4">
          <AgyOAuthSection helpSide="top" />
        </div>
      )}
    </div>
  );
}
