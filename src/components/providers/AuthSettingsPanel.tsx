import { useTranslation } from "react-i18next";
import { FullScreenPanel } from "@/components/common/FullScreenPanel";
import { AuthCenterPanel } from "@/components/settings/AuthCenterPanel";
import type { AuthCenterTarget, ManagementTarget } from "@/lib/api";

interface AuthSettingsPanelProps {
  target: AuthCenterTarget | null;
  managementTarget?: ManagementTarget;
  onClose: () => void;
}

export function AuthSettingsPanel({
  target,
  managementTarget,
  onClose,
}: AuthSettingsPanelProps) {
  const { t } = useTranslation();
  const isOpen = target !== null;

  return (
    <FullScreenPanel
      isOpen={isOpen}
      title={t("nav.auth")}
      onClose={onClose}
      motionPreset="slide-from-right"
    >
      {target ? (
        <AuthCenterPanel authScrollTarget={target} target={managementTarget} />
      ) : null}
    </FullScreenPanel>
  );
}
