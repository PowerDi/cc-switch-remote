import { describe, expect, it } from "vitest";
import en from "@/i18n/locales/en.json";
import ja from "@/i18n/locales/ja.json";
import zh from "@/i18n/locales/zh.json";
import zhTW from "@/i18n/locales/zh-TW.json";
import enRaw from "@/i18n/locales/en.json?raw";
import jaRaw from "@/i18n/locales/ja.json?raw";
import zhRaw from "@/i18n/locales/zh.json?raw";
import zhTWRaw from "@/i18n/locales/zh-TW.json?raw";

const locales = [
  ["en", en, enRaw],
  ["ja", ja, jaRaw],
  ["zh", zh, zhRaw],
  ["zh-TW", zhTW, zhTWRaw],
] as const;

function variables(value: string) {
  return [...value.matchAll(/\{\{([^}]+)\}\}/g)]
    .map((match) => match[1])
    .sort();
}

describe("v4 locale fork boundaries", () => {
  it.each(locales)(
    "keeps Remote identity and brands new product copy in %s",
    (_lang, locale) => {
      expect(locale.app.title).toBe("CC Switch Remote");
      expect(locale.provider.adoptCatalog).toContain("CC Switch Remote");
      expect(locale.nav.settingsHasUpdate).toContain("CC Switch Remote");
      expect(locale.settings.toolUpgradeUnmanagedDetail).toContain(
        "CC Switch Remote",
      );
      expect(locale.remote.unsupportedUsageRead.length).toBeGreaterThan(0);
      // v4 storage sheet replaces the deleted picker; do not leave three orphaned labels.
      expect(locale.settings).not.toHaveProperty("skillStorage");
      expect(locale.skills.storageSheet.locationCcSwitch).toContain(
        "CC Switch Remote",
      );
    },
  );

  it.each(locales)(
    "retains both remote scan and toolbar messages without duplicate keys in %s",
    (_lang, locale, source) => {
      expect(source.match(/"sessionSync"\s*:/g)).toHaveLength(1);
      expect(locale.usage.sessionSync.manualTitle.length).toBeGreaterThan(0);
      expect(locale.usage.sessionSync.manualDescription.length).toBeGreaterThan(
        0,
      );
      expect(locale.usage.sessionSync.trigger.length).toBeGreaterThan(0);
      expect(variables(locale.usage.sessionSync.syncCompleted)).toEqual([
        "deferred",
        "errors",
        "files",
        "imported",
      ]);
      expect(variables(locale.usage.sessionSync.syncFailed)).toEqual(["error"]);
      expect(source).not.toMatch(/^<<<<<<<|^=======|^>>>>>>>/m);
    },
  );
});
