import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import {
  fireEvent,
  render,
  screen,
  waitFor,
  within,
} from "@testing-library/react";
import { beforeEach, describe, expect, it, vi } from "vitest";
import { RemoteAppConfigSection } from "@/components/settings/RemoteAppConfigSection";
import { AppConfigSection } from "@/components/settings/sections/AppConfigSection";
import type { ManagementTarget } from "@/lib/api/remote";
import type { Settings } from "@/types";
import type {
  ResolvedDirectories,
  SettingsFormState,
} from "@/hooks/useSettings";

const capability = vi.hoisted(() => ({ omp: true }));
vi.mock("@/hooks/useTargetCapability", () => ({
  useTargetCapability: () => capability.omp,
}));
vi.mock("@/components/settings/CodexAuthSettings", () => ({
  CodexAuthSettings: () => null,
}));
const target: Extract<ManagementTarget, { type: "remote" }> = {
  type: "remote",
  profile: {
    id: "omp-host",
    name: "OMP host",
    host: "192.0.2.30",
    port: 22,
    username: "test",
    authMethod: { type: "sshAgent" },
    helperPath: "~/.local/bin/cc-switch-remote-helper",
    createdAt: 1,
    updatedAt: 1,
  },
  secret: { password: "test-secret" },
};
const settings = {
  ompConfigDir: "/srv/omp",
  claudeConfigDir: "/srv/claude",
} as Settings;
function renderRemote(onSave = vi.fn().mockResolvedValue(true)) {
  const client = new QueryClient({
    defaultOptions: { queries: { retry: false } },
  });
  const view = render(
    <QueryClientProvider client={client}>
      <RemoteAppConfigSection
        target={target}
        settings={settings}
        isSaving={false}
        onSave={onSave}
      />
    </QueryClientProvider>,
  );
  return { ...view, onSave, client };
}
beforeEach(() => {
  capability.omp = true;
});
describe("App config management target", () => {
  it("saves OMP directory changes through the selected remote settings workflow", async () => {
    const { container, onSave, client } = renderRemote();
    client.setQueryData(["omp", "currentState", "remote:omp-host"], {});
    const block = container.querySelector("#app-config-omp") as HTMLElement;
    expect(block).toBeInTheDocument();
    expect(
      within(block).queryByRole("button", { name: "settings.browseDirectory" }),
    ).toBeNull();
    fireEvent.change(within(block).getByRole("textbox"), {
      target: { value: "  /srv/new-omp  " },
    });
    fireEvent.click(within(block).getByRole("button", { name: "common.save" }));
    await waitFor(() =>
      expect(onSave).toHaveBeenCalledWith(
        expect.objectContaining({
          ompConfigDir: "/srv/new-omp",
          claudeConfigDir: "/srv/claude",
        }),
      ),
    );
    await waitFor(() =>
      expect(
        client.getQueryState(["omp", "currentState", "remote:omp-host"])
          ?.isInvalidated,
      ).toBe(true),
    );
  });
  it("retains the previous directory when remote reset fails", async () => {
    const onSave = vi.fn().mockResolvedValue(false);
    const { container } = renderRemote(onSave);
    const block = container.querySelector("#app-config-omp") as HTMLElement;
    fireEvent.click(
      within(block).getByRole("button", { name: "settings.resetDefault" }),
    );
    await waitFor(() =>
      expect(onSave).toHaveBeenCalledWith({ ompConfigDir: undefined }),
    );
    expect(within(block).getByRole("textbox")).toHaveValue("/srv/omp");
  });
  it("hides OMP directory settings when the helper lacks its capability", () => {
    capability.omp = false;
    const { container } = renderRemote();
    expect(container.querySelector("#app-config-omp")).toBeNull();
    expect(container.querySelector("#app-config-pi")).toBeInTheDocument();
  });
  it("keeps local directory browsing on the original callback", () => {
    const browse = vi.fn().mockResolvedValue(undefined);
    render(
      <AppConfigSection
        settings={settings as SettingsFormState}
        savedSettings={settings}
        resolvedDirs={{ omp: "/home/test/.omp/agent" } as ResolvedDirectories}
        isSaving={false}
        supportedApps={["omp"]}
        onAutoSave={vi.fn()}
        onDirectoryChange={vi.fn()}
        onBrowseDirectory={browse}
        onResetDirectory={vi.fn()}
        onSaveDirectories={vi.fn()}
      />,
    );
    fireEvent.click(
      screen.getByRole("button", { name: "settings.browseDirectory" }),
    );
    expect(browse).toHaveBeenCalledWith("omp");
  });
});
