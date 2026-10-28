import type { ReactNode } from "react";
import {
  act,
  cleanup,
  fireEvent,
  render,
  screen,
  waitFor,
  within,
} from "@testing-library/react";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import {
  afterEach,
  beforeAll,
  beforeEach,
  describe,
  expect,
  it,
  vi,
} from "vitest";
import { ProfileManageDialog } from "@/components/profiles/ProfileManageDialog";
import { ProfileSwitcher } from "@/components/profiles/ProfileSwitcher";
import type { ManagementTarget } from "@/lib/api/remote";
import type { Profile, ProfilesResponse } from "@/lib/api/profiles";

const invoke = vi.hoisted(() => vi.fn());
const tray = vi.hoisted(() => vi.fn());
const toast = vi.hoisted(() => ({
  success: vi.fn(),
  warning: vi.fn(),
  error: vi.fn(),
}));
vi.mock("@tauri-apps/api/core", () => ({
  invoke: (...args: unknown[]) => invoke(...args),
}));
// The barrel still contains unrelated merge conflicts; exercise the real
// profiles API -> remoteApi -> invoke chain, mocking only the local tray.
vi.mock("@/lib/api", () => ({ providersApi: { updateTrayMenu: tray } }));
vi.mock("@/lib/toast", () => ({ toast }));
vi.mock("react-i18next", () => ({
  useTranslation: () => ({ t: (key: string) => key }),
}));

const remote: ManagementTarget = {
  type: "remote",
  profile: {
    id: "a",
    name: "A",
    host: "192.0.2.1",
    port: 22,
    username: "tester",
    authMethod: { type: "sshAgent" },
    helperPath: "/bin/helper",
    createdAt: 1,
    updatedAt: 1,
  },
  secret: { password: "first-secret" },
};
const replacement: ManagementTarget = {
  ...remote,
  profile: { ...remote.profile, host: "192.0.2.2" },
  secret: { password: "second-secret" },
};
const local: ManagementTarget = { type: "local" };
const profile = (name: string): Profile => ({
  id: "same-id",
  name,
  payload: {
    providers: { claude: null, "claude-desktop": null, codex: null },
    mcp: { claude: null, "claude-desktop": null, codex: null },
    skills: { claude: null, "claude-desktop": null, codex: null },
    prompts: { claude: null, "claude-desktop": null, codex: null },
  },
});
const listing = (name: string): ProfilesResponse => ({
  profiles: [profile(name)],
  currentIds: { claude: null, claudeDesktop: null, codex: null },
});
const clients: QueryClient[] = [];
function setup() {
  const client = new QueryClient({
    defaultOptions: { queries: { retry: false }, mutations: { retry: false } },
  });
  clients.push(client);
  const wrapper = ({ children }: { children: ReactNode }) => (
    <QueryClientProvider client={client}>{children}</QueryClientProvider>
  );
  return { client, wrapper };
}
beforeAll(() => {
  if (!Element.prototype.scrollIntoView)
    Element.prototype.scrollIntoView = vi.fn();
});
beforeEach(() => {
  invoke.mockReset();
  tray.mockReset();
  Object.values(toast).forEach((mock) => mock.mockReset());
  invoke.mockImplementation(
    async (
      command: string,
      args?: { profile?: { host: string }; name?: string },
    ) => {
      if (command === "remote_check_health") {
        return { capabilities: ["profiles"] };
      }
      if (command === "list_profiles") return listing("Local project");
      if (command === "remote_list_project_profiles")
        return listing(
          args?.profile?.host === remote.profile.host
            ? "Remote project"
            : "Replacement project",
        );
      if (command === "remote_create_project_profile")
        return profile(args?.name ?? "new");
      if (command === "remote_apply_project_profile") return [];
      if (command === "remote_update_project_profile")
        return profile(args?.name ?? "renamed");
      if (command === "remote_delete_project_profile") return undefined;
      throw new Error(`Unexpected command: ${command}`);
    },
  );
});
afterEach(() => {
  cleanup();
  clients.splice(0).forEach((client) => client.clear());
});

async function openCreate() {
  fireEvent.click(await screen.findByRole("combobox"));
  fireEvent.click(
    await screen.findByRole("option", { name: "profiles.createFromCurrent" }),
  );
  return screen.findByPlaceholderText("profiles.namePlaceholder");
}

describe("shared profile UI target safety", () => {
  it.each([local, replacement])(
    "drops a pending delete confirmation on target/connection changes ($type)",
    async (target) => {
      const { wrapper } = setup();
      const onClose = vi.fn();
      const { rerender } = render(
        <ProfileManageDialog isOpen onClose={onClose} target={remote} />,
        { wrapper },
      );
      await screen.findByText("Remote project");
      fireEvent.click(screen.getByRole("button", { name: "profiles.delete" }));
      expect(
        screen.getByRole("dialog", { name: "profiles.deleteConfirmTitle" }),
      ).toBeInTheDocument();
      rerender(
        <ProfileManageDialog isOpen onClose={onClose} target={target} />,
      );
      expect(
        screen.queryByRole("dialog", { name: "profiles.deleteConfirmTitle" }),
      ).not.toBeInTheDocument();
      await screen.findByText(
        target.type === "local" ? "Local project" : "Replacement project",
      );
      expect(
        invoke.mock.calls.some(([name]) => String(name).includes("delete")),
      ).toBe(false);
      expect(tray).not.toHaveBeenCalled();
    },
  );

  it("cannot carry an old rename draft onto the replacement host's identical profile ID", async () => {
    const { wrapper } = setup();
    const onClose = vi.fn();
    const { rerender } = render(
      <ProfileManageDialog isOpen onClose={onClose} target={remote} />,
      { wrapper },
    );
    await screen.findByText("Remote project");
    fireEvent.click(screen.getByRole("button", { name: "profiles.rename" }));
    fireEvent.change(screen.getByRole("textbox"), {
      target: { value: "Old draft" },
    });
    rerender(
      <ProfileManageDialog isOpen onClose={onClose} target={replacement} />,
    );
    expect(screen.queryByDisplayValue("Old draft")).not.toBeInTheDocument();
    await screen.findByText("Replacement project");
    fireEvent.click(screen.getByRole("button", { name: "profiles.rename" }));
    expect(screen.getByRole("textbox")).toHaveValue("Replacement project");
    fireEvent.change(screen.getByRole("textbox"), { target: { value: "   " } });
    fireEvent.keyDown(screen.getByRole("textbox"), { key: "Enter" });
    expect(
      screen.getByRole("button", { name: "common.confirm" }),
    ).toBeDisabled();
    expect(
      invoke.mock.calls.some(([name]) => String(name).includes("update")),
    ).toBe(false);
    fireEvent.change(screen.getByRole("textbox"), {
      target: { value: "  New name  " },
    });
    fireEvent.click(screen.getByRole("button", { name: "common.confirm" }));
    await waitFor(() =>
      expect(invoke).toHaveBeenCalledWith("remote_update_project_profile", {
        profile: replacement.profile,
        secret: replacement.secret,
        id: "same-id",
        name: "New name",
        resnapshot: null,
        scope: null,
      }),
    );
    expect(tray).not.toHaveBeenCalled();
  });

  it("closes and discards confirmations when the management dialog is hidden", async () => {
    const { wrapper } = setup();
    const onClose = vi.fn();
    const { rerender } = render(
      <ProfileManageDialog isOpen onClose={onClose} target={remote} />,
      { wrapper },
    );
    await screen.findByText("Remote project");
    fireEvent.click(screen.getByRole("button", { name: "profiles.delete" }));
    rerender(
      <ProfileManageDialog isOpen={false} onClose={onClose} target={remote} />,
    );
    expect(screen.queryByRole("dialog")).not.toBeInTheDocument();
    rerender(<ProfileManageDialog isOpen onClose={onClose} target={remote} />);
    await screen.findByText("Remote project");
    expect(
      screen.queryByRole("dialog", { name: "profiles.deleteConfirmTitle" }),
    ).not.toBeInTheDocument();
  });

  it("keeps the real create form validation, target routing and success close behavior", async () => {
    const { wrapper } = setup();
    render(<ProfileSwitcher activeApp="codex" target={remote} />, { wrapper });
    const input = await openCreate();
    fireEvent.change(input, { target: { value: "  " } });
    fireEvent.keyDown(input, { key: "Enter" });
    expect(
      screen.getByRole("button", { name: "common.confirm" }),
    ).toBeDisabled();
    expect(
      invoke.mock.calls.some(([name]) => String(name).includes("create")),
    ).toBe(false);
    fireEvent.change(input, { target: { value: "  New remote project  " } });
    fireEvent.click(screen.getByRole("button", { name: "common.confirm" }));
    await waitFor(() =>
      expect(invoke).toHaveBeenCalledWith("remote_create_project_profile", {
        profile: remote.profile,
        secret: remote.secret,
        name: "New remote project",
        scope: "codex",
      }),
    );
    await waitFor(() =>
      expect(screen.queryByRole("dialog")).not.toBeInTheDocument(),
    );
    expect(toast.success).toHaveBeenCalledWith("profiles.createSuccess", {
      closeButton: true,
    });
    expect(tray).not.toHaveBeenCalled();
  });

  it.each(["target", "scope"])(
    "discards the create draft when changing %s",
    async (change) => {
      const { wrapper } = setup();
      const { rerender } = render(
        <ProfileSwitcher activeApp="codex" target={remote} />,
        { wrapper },
      );
      fireEvent.change(await openCreate(), { target: { value: "Old draft" } });
      rerender(
        <ProfileSwitcher
          activeApp={change === "scope" ? "claude" : "codex"}
          target={change === "target" ? replacement : remote}
        />,
      );
      expect(screen.queryByRole("dialog")).not.toBeInTheDocument();
      expect(await openCreate()).toHaveValue("");
      expect(
        invoke.mock.calls.some(([name]) => String(name).includes("create")),
      ).toBe(false);
    },
  );

  it("late create completion cannot close a newly opened dialog on another host", async () => {
    let finish!: (value: Profile) => void;
    const defaultInvoke = invoke.getMockImplementation()!;
    invoke.mockImplementation((command, args) =>
      command === "remote_create_project_profile"
        ? new Promise<Profile>((resolve) => {
            finish = resolve;
          })
        : defaultInvoke(command, args),
    );
    const { wrapper } = setup();
    const { rerender } = render(
      <ProfileSwitcher activeApp="codex" target={remote} />,
      { wrapper },
    );
    fireEvent.change(await openCreate(), {
      target: { value: "First project" },
    });
    fireEvent.click(screen.getByRole("button", { name: "common.confirm" }));
    await waitFor(() => expect(finish).toBeDefined());
    rerender(<ProfileSwitcher activeApp="codex" target={replacement} />);
    fireEvent.change(await openCreate(), { target: { value: "Second draft" } });
    await act(async () => finish(profile("First project")));
    expect(screen.getByPlaceholderText("profiles.namePlaceholder")).toHaveValue(
      "Second draft",
    );
    expect(screen.getByRole("dialog")).toBeInTheDocument();
  });

  it("passes the selected target into the nested management dialog", async () => {
    const { wrapper } = setup();
    render(<ProfileSwitcher activeApp="codex" target={remote} />, { wrapper });
    fireEvent.click(await screen.findByRole("combobox"));
    fireEvent.click(
      await screen.findByRole("option", { name: "profiles.manage" }),
    );
    const dialog = await screen.findByRole("dialog", {
      name: "profiles.manageTitle",
    });
    expect(
      await within(dialog).findByText("Remote project"),
    ).toBeInTheDocument();
    expect(
      invoke.mock.calls.every(([command]) => command !== "list_profiles"),
    ).toBe(true);
  });

  it("hides the entry instead of failing when the helper lacks profile support", async () => {
    const { wrapper } = setup();
    invoke.mockImplementation(async (command: string) => {
      if (command === "remote_check_health") return { capabilities: [] };
      throw new Error(`Unexpected command: ${command}`);
    });
    render(<ProfileSwitcher activeApp="codex" target={remote} />, { wrapper });
    await waitFor(() =>
      // 能力门控只查已安装 Helper，不查 GitHub 最新版本（v4.0.8 起）
      expect(invoke).toHaveBeenCalledWith("remote_check_health", {
        profile: remote.profile,
        secret: remote.secret,
        includeLatest: false,
      }),
    );
    expect(screen.queryByRole("combobox")).not.toBeInTheDocument();
    expect(
      invoke.mock.calls.some(([command]) =>
        String(command).includes("project_profile"),
      ),
    ).toBe(false);
    expect(toast.error).not.toHaveBeenCalled();
  });

  it("does not lend the previous host's capabilities to a replacement connection", async () => {
    const { wrapper } = setup();
    invoke.mockImplementation(
      async (command: string, args?: { profile?: { host: string } }) => {
        if (command === "remote_check_health")
          return {
            capabilities:
              args?.profile?.host === remote.profile.host ? ["profiles"] : [],
          };
        if (command === "remote_list_project_profiles")
          return listing("Remote project");
        throw new Error(`Unexpected command: ${command}`);
      },
    );
    const { rerender } = render(
      <ProfileSwitcher activeApp="codex" target={remote} />,
      { wrapper },
    );
    expect(await screen.findByRole("combobox")).toBeInTheDocument();
    rerender(<ProfileSwitcher activeApp="codex" target={replacement} />);
    await waitFor(() =>
      expect(screen.queryByRole("combobox")).not.toBeInTheDocument(),
    );
    const listedReplacement = invoke.mock.calls.some(
      ([command, args]) =>
        command === "remote_list_project_profiles" &&
        (args as { profile: { host: string } }).profile.host ===
          replacement.profile.host,
    );
    expect(listedReplacement).toBe(false);
  });

  it("does not read profiles for unsupported app scopes", () => {
    const { wrapper } = setup();
    render(<ProfileSwitcher activeApp="gemini" target={remote} />, { wrapper });
    expect(screen.queryByRole("combobox")).not.toBeInTheDocument();
    expect(invoke).not.toHaveBeenCalled();
  });
});
