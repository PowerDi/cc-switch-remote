import { describe, expect, it } from "vitest";
import { providerPresets } from "@/config/claudeProviderPresets";
import { claudeDesktopProviderPresets } from "@/config/claudeDesktopProviderPresets";
import { codexProviderPresets } from "@/config/codexProviderPresets";
import { geminiProviderPresets } from "@/config/geminiProviderPresets";
import { grokBuildProviderPresets } from "@/config/grokBuildProviderPresets";
import { hermesProviderPresets } from "@/config/hermesProviderPresets";
import { openclawProviderPresets } from "@/config/openclawProviderPresets";
import { opencodeProviderPresets } from "@/config/opencodeProviderPresets";
import { piProviderPresets } from "@/config/piProviderPresets";

const collections = [
  ["claude", providerPresets, true],
  ["claude-desktop", claudeDesktopProviderPresets, true],
  ["codex", codexProviderPresets, true],
  ["gemini", geminiProviderPresets, false],
  ["grokbuild", grokBuildProviderPresets, false],
  ["hermes", hermesProviderPresets, true],
  ["openclaw", openclawProviderPresets, true],
  ["opencode", opencodeProviderPresets, true],
  ["pi", piProviderPresets, true],
] as const;

// New release providers remain usable. Partnership claims / tracking links
// were not accepted by this fork merely by merging the official release.
const neutralSignupUrls = {
  "FluxA Token Plan": "https://agentmarket.fluxapay.xyz/marketplace/tokenplans",
  "88API": "https://88api.ai/sign-up",
  "9527CODE": "https://9527.codes/register",
  SoleAPI: "https://soleapi.com",
};

describe("fork preset promotion boundary", () => {
  it.each(collections)(
    "%s retains functional presets without introducing unreviewed partnerships",
    (_app, presets, supportsFluxa) => {
      const names = Object.keys(neutralSignupUrls).filter(
        (name) => supportsFluxa || name !== "FluxA Token Plan",
      );
      for (const name of names) {
        const preset = presets.find((value) => value.name === name);
        expect(
          preset,
          `${name} must not be removed to pass a promotion test`,
        ).toBeDefined();
        expect(preset?.isPartner).not.toBe(true);
        expect(preset?.partnerPromotionKey).toBeUndefined();
        expect(preset?.apiKeyUrl).toBe(
          neutralSignupUrls[name as keyof typeof neutralSignupUrls],
        );
      }
    },
  );
});
