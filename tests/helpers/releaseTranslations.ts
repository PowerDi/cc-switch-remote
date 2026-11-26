import en from "../../src/i18n/locales/en.json";

/** Real release UI wording, with deterministic interpolation and no application i18n startup. */
export function releaseT(
  key: string,
  options?: string | Record<string, unknown>,
): string {
  const value = key
    .split(".")
    .reduce<unknown>(
      (node, part) =>
        node && typeof node === "object"
          ? (node as Record<string, unknown>)[part]
          : undefined,
      en,
    );
  const fallback =
    typeof options === "string" ? options : options?.defaultValue;
  const text =
    typeof value === "string"
      ? value
      : typeof fallback === "string"
        ? fallback
        : key;
  return text.replace(/\{\{([^}]+)\}\}/g, (_, name: string) =>
    String(typeof options === "object" ? (options[name] ?? "") : ""),
  );
}
