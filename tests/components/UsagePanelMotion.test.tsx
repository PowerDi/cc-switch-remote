import { render, screen } from "@testing-library/react";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { describe, expect, it, vi } from "vitest";
import UsageScriptModal from "@/components/UsageScriptModal";
import { PricingEditModal } from "@/components/usage/PricingEditModal";

vi.mock("@/lib/query", () => ({
  useSettingsQuery: () => ({ data: { usageConfirmed: true } }),
}));
// Fork：用量脚本弹窗按管理目标生成查询键（usageScriptResultKey），保留真实实现
vi.mock("@/lib/query/usage", async (importOriginal) => ({
  ...(await importOriginal<typeof import("@/lib/query/usage")>()),
  useUpdateModelPricing: () => ({ mutateAsync: vi.fn(), isPending: false }),
}));
vi.mock("@/components/JsonEditor", () => ({ default: () => <div /> }));

describe("Usage pages render without a transparent opening frame", () => {
  it("opens usage query configuration fully opaque", () => {
    render(
      <QueryClientProvider client={new QueryClient()}>
        <UsageScriptModal
          isOpen
          provider={{ id: "test", name: "Test Provider", settingsConfig: {} }}
          appId="claude"
          onClose={vi.fn()}
          onSave={vi.fn()}
        />
      </QueryClientProvider>,
    );
    expect(screen.getByRole("heading").closest(".bg-app")).toHaveStyle({
      opacity: "1",
    });
  });

  it.each([true, false])("opens pricing fully opaque (isNew=%s)", (isNew) => {
    render(
      <PricingEditModal
        open
        isNew={isNew}
        model={{
          modelId: "test",
          displayName: "Test",
          inputCostPerMillion: "1",
          outputCostPerMillion: "2",
          cacheReadCostPerMillion: "0",
          cacheCreationCostPerMillion: "0",
        }}
        onClose={vi.fn()}
      />,
    );
    expect(screen.getByRole("heading").closest(".bg-app")).toHaveStyle({
      opacity: "1",
    });
  });
});
