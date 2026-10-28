import { render, screen } from "@testing-library/react";
import { beforeEach, describe, expect, it, vi } from "vitest";
import { UsageHeatmap } from "@/components/usage/UsageHeatmap";
import type { ManagementTarget } from "@/lib/api/remote";
const mocks = vi.hoisted(() => ({
  firstDateSupported: false,
  firstDate: vi.fn(),
  trends: vi.fn(),
}));
vi.mock("@/hooks/useTargetCapability", () => ({
  useTargetCapability: () => mocks.firstDateSupported,
}));
vi.mock("@/hooks/useMoneyFormat", () => ({
  useMoneyFormat: () => ({ money: (value: number) => String(value) }),
}));
vi.mock("@/lib/query/usage", () => ({
  useUsageFirstDate: (...args: unknown[]) => mocks.firstDate(...args),
  useUsageTrends: (...args: unknown[]) => mocks.trends(...args),
}));
const target: ManagementTarget = {
  type: "remote",
  profile: {
    id: "heatmap-host",
    name: "Heatmap",
    host: "192.0.2.2",
    port: 22,
    username: "user",
    authMethod: { type: "sshAgent" },
    helperPath: "helper",
    createdAt: 1,
    updatedAt: 1,
  },
};
beforeEach(() => {
  mocks.firstDateSupported = false;
  mocks.firstDate
    .mockReset()
    .mockReturnValue({ isSuccess: false, isPending: true });
  mocks.trends.mockReset().mockReturnValue({ data: [], isLoading: false });
});
describe("remote heatmap capabilities", () => {
  it("loads the recent span when an older helper has no first-date command", () => {
    render(
      <UsageHeatmap target={target} metric="tokens" refreshIntervalMs={0} />,
    );
    expect(mocks.trends).toHaveBeenCalledWith(
      expect.anything(),
      expect.anything(),
      expect.objectContaining({ enabled: true }),
      target,
    );
    expect(screen.queryByRole("status")).toBeNull();
  });
  it("passes the selected target to first-date and trend queries", () => {
    mocks.firstDateSupported = true;
    mocks.firstDate.mockReturnValue({
      data: "2020-01-01",
      isSuccess: true,
      isPending: false,
    });
    render(
      <UsageHeatmap
        target={target}
        appType="omp"
        metric="requests"
        refreshIntervalMs={0}
      />,
    );
    expect(mocks.firstDate).toHaveBeenCalledWith(
      expect.objectContaining({ appType: "omp" }),
      expect.anything(),
      target,
    );
    expect(mocks.trends).toHaveBeenCalledWith(
      expect.anything(),
      expect.objectContaining({ appType: "omp" }),
      expect.objectContaining({ enabled: true }),
      target,
    );
  });
});
