import {
  act,
  cleanup,
  fireEvent,
  render,
  screen,
  waitFor,
} from "@testing-library/react";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { ManagementTarget } from "@/lib/api/remote";

const mocks = vi.hoisted(() => ({
  invoke: vi.fn(),
  success: vi.fn(),
  error: vi.fn(),
}));
vi.mock("@tauri-apps/api/core", () => ({ invoke: mocks.invoke }));
vi.mock("@/lib/toast", () => ({
  toast: { success: mocks.success, error: mocks.error },
}));

import HermesMemoryPanel, {
  HermesMemorySaveButton,
} from "@/components/hermes/HermesMemoryPanel";
import {
  createHermesMemoryDraftStore,
  hermesMemoryDrafts,
} from "@/components/hermes/hermesMemoryDrafts";

const local: ManagementTarget = { type: "local" };
const remote: ManagementTarget = {
  type: "remote",
  profile: {
    id: "host-a",
    name: "Host A",
    host: "192.0.2.10",
    port: 22,
    username: "tester",
    authMethod: { type: "sshAgent" },
    helperPath: "/bin/helper",
    createdAt: 0,
    updatedAt: 0,
  },
  secret: { password: "fixture-password" },
};
const limits = {
  memory: 2200,
  user: 1375,
  memoryEnabled: true,
  userEnabled: true,
};
const clients: QueryClient[] = [];
function deferred<T>() {
  let resolve!: (value: T) => void;
  let reject!: (reason: unknown) => void;
  const promise = new Promise<T>((res, rej) => {
    resolve = res;
    reject = rej;
  });
  return { promise, resolve, reject };
}
function setup(target: ManagementTarget = local) {
  const client = new QueryClient({
    defaultOptions: { queries: { retry: false }, mutations: { retry: false } },
  });
  clients.push(client);
  const onOpen = vi.fn();
  const page = (current: ManagementTarget) => (
    <QueryClientProvider client={client}>
      <HermesMemorySaveButton target={current} />
      <HermesMemoryPanel target={current} onOpenWebUI={onOpen} />
    </QueryClientProvider>
  );
  const view = render(page(target));
  return {
    client,
    onOpen,
    ...view,
    switchTo: (next: ManagementTarget) => view.rerender(page(next)),
  };
}
const memoryEditor = () =>
  screen.getAllByLabelText("hermes.memory.editorLabel", {
    selector: "textarea",
  })[0];
const save = () =>
  fireEvent.click(screen.getByRole("button", { name: "common.save" }));

beforeEach(() => {
  hermesMemoryDrafts.reset();
  mocks.success.mockReset();
  mocks.error.mockReset();
  mocks.invoke
    .mockReset()
    .mockImplementation(async (command: string, args: any) => {
      switch (command) {
        case "remote_check_health":
          return { capabilities: ["hermes-memory"] };
        case "get_hermes_memory":
          return `local ${args.kind}`;
        case "remote_get_hermes_memory":
          return `${args.profile.host} ${args.kind}`;
        case "get_hermes_memory_limits":
        case "remote_get_hermes_memory_limits":
          return limits;
        case "get_config_dir":
          return "/home/local/.hermes";
        case "set_hermes_memory":
        case "remote_set_hermes_memory":
        case "set_hermes_memory_enabled":
        case "remote_set_hermes_memory_enabled":
          return undefined;
        default:
          throw new Error(`Unexpected invoke: ${command}`);
      }
    });
});
afterEach(() => {
  cleanup();
  clients.splice(0).forEach((client) => client.clear());
});

describe("Hermes memory target workflow", () => {
  it("keeps the v4 local editor, header save and enable switch on the original local commands", async () => {
    const { onOpen } = setup();
    await waitFor(() => expect(memoryEditor()).toHaveValue("local memory"));
    fireEvent.change(memoryEditor(), { target: { value: "local draft" } });
    save();
    await waitFor(() =>
      expect(mocks.invoke).toHaveBeenCalledWith("set_hermes_memory", {
        kind: "memory",
        content: "local draft",
      }),
    );
    fireEvent.click(screen.getAllByRole("switch")[0]);
    await waitFor(() =>
      expect(mocks.invoke).toHaveBeenCalledWith("set_hermes_memory_enabled", {
        kind: "memory",
        enabled: false,
      }),
    );
    fireEvent.click(
      screen.getByRole("button", { name: /hermes.memory.openConfig/ }),
    );
    expect(onOpen).toHaveBeenCalledWith("/config");
    expect(
      mocks.invoke.mock.calls.some(([command]) =>
        command.startsWith("remote_"),
      ),
    ).toBe(false);
  });

  it("routes reads, save, toggle and refresh through the selected profile/secret without local side effects", async () => {
    const { client, onOpen } = setup(remote);
    await waitFor(() =>
      expect(memoryEditor()).toHaveValue("192.0.2.10 memory"),
    );
    expect(
      screen.queryByRole("button", { name: /hermes.memory.openConfig/ }),
    ).toBeNull();
    expect(screen.getByRole("tabpanel")).not.toHaveTextContent("~/.hermes");
    fireEvent.change(memoryEditor(), { target: { value: "remote draft" } });
    save();
    await waitFor(() =>
      expect(mocks.invoke).toHaveBeenCalledWith("remote_set_hermes_memory", {
        profile: remote.profile,
        secret: remote.secret,
        kind: "memory",
        content: "remote draft",
      }),
    );
    await waitFor(() =>
      expect(mocks.success).toHaveBeenCalledWith("hermes.memory.saveSuccess"),
    );
    fireEvent.click(screen.getAllByRole("switch")[0]);
    await waitFor(() =>
      expect(mocks.invoke).toHaveBeenCalledWith(
        "remote_set_hermes_memory_enabled",
        {
          profile: remote.profile,
          secret: remote.secret,
          kind: "memory",
          enabled: false,
        },
      ),
    );
    await waitFor(() =>
      expect(
        mocks.invoke.mock.calls.filter(
          ([command]) => command === "remote_get_hermes_memory_limits",
        ).length,
      ).toBeGreaterThan(1),
    );
    expect(
      mocks.invoke.mock.calls.every(([command]) =>
        command.startsWith("remote_"),
      ),
    ).toBe(true);
    expect(onOpen).not.toHaveBeenCalled();
    const keys = client
      .getQueryCache()
      .getAll()
      .map((query) => query.queryKey);
    expect(JSON.stringify(keys)).toContain("remote:host-a");
    expect(JSON.stringify(keys)).not.toContain("fixture-password");
  });

  it("does not expose editors or issue memory commands without helper capability", async () => {
    mocks.invoke.mockResolvedValue({ capabilities: [] });
    setup(remote);
    await waitFor(() =>
      expect(mocks.invoke).toHaveBeenCalledWith(
        "remote_check_health",
        expect.anything(),
      ),
    );
    expect(screen.getByRole("status")).toHaveTextContent(
      "hermes.memory.helperRequired",
    );
    expect(screen.queryByRole("textbox")).toBeNull();
    expect(screen.queryByRole("button", { name: "common.save" })).toBeNull();
    expect(
      mocks.invoke.mock.calls.every(
        ([command]) => command === "remote_check_health",
      ),
    ).toBe(true);
  });

  it("preserves a failed-save draft and reports a localized failure", async () => {
    const original = mocks.invoke.getMockImplementation()!;
    mocks.invoke.mockImplementation((command, args) =>
      command === "remote_set_hermes_memory"
        ? Promise.reject(new Error("disk full"))
        : original(command, args),
    );
    setup(remote);
    await waitFor(() =>
      expect(memoryEditor()).toHaveValue("192.0.2.10 memory"),
    );
    fireEvent.change(memoryEditor(), {
      target: { value: "unsaved remote text" },
    });
    save();
    await waitFor(() =>
      expect(mocks.error).toHaveBeenCalledWith("hermes.memory.saveFailed", {
        description: "disk full",
      }),
    );
    expect(memoryEditor()).toHaveValue("unsaved remote text");
    expect(
      screen.getByRole("img", { name: "hermes.memory.unsaved" }),
    ).toBeInTheDocument();
    expect(mocks.success).not.toHaveBeenCalled();
  });

  it("a late save cannot hydrate or mark the next connection's draft as saved", async () => {
    const pending = deferred<void>();
    const original = mocks.invoke.getMockImplementation()!;
    mocks.invoke.mockImplementation((command, args) =>
      command === "remote_set_hermes_memory"
        ? pending.promise
        : original(command, args),
    );
    const { switchTo } = setup(remote);
    await waitFor(() =>
      expect(memoryEditor()).toHaveValue("192.0.2.10 memory"),
    );
    fireEvent.change(memoryEditor(), {
      target: { value: "old connection draft" },
    });
    save();
    await waitFor(() =>
      expect(mocks.invoke).toHaveBeenCalledWith(
        "remote_set_hermes_memory",
        expect.objectContaining({ content: "old connection draft" }),
      ),
    );
    // Same profile ID, but a new host and secret: old cache and draft are unusable.
    switchTo({
      ...remote,
      profile: { ...remote.profile, host: "192.0.2.11" },
      secret: { password: "replacement" },
    });
    await waitFor(() =>
      expect(memoryEditor()).toHaveValue("192.0.2.11 memory"),
    );
    fireEvent.change(memoryEditor(), {
      target: { value: "new connection draft" },
    });
    await act(async () => {
      pending.resolve();
      await pending.promise;
    });
    expect(memoryEditor()).toHaveValue("new connection draft");
    expect(
      screen.getByRole("img", { name: "hermes.memory.unsaved" }),
    ).toBeInTheDocument();
    expect(mocks.success).not.toHaveBeenCalled();
  });

  it("does not reuse remote drafts for local and does not apply a late read to the new host", async () => {
    const pending = deferred<string>();
    const original = mocks.invoke.getMockImplementation()!;
    mocks.invoke.mockImplementation((command, args) =>
      command === "remote_get_hermes_memory" && args.kind === "memory"
        ? pending.promise
        : original(command, args),
    );
    const { switchTo } = setup(remote);
    await waitFor(() =>
      expect(mocks.invoke).toHaveBeenCalledWith(
        "remote_get_hermes_memory",
        expect.objectContaining({ kind: "memory" }),
      ),
    );
    switchTo(local);
    await waitFor(() => expect(memoryEditor()).toHaveValue("local memory"));
    fireEvent.change(memoryEditor(), { target: { value: "local edits" } });
    await act(async () => {
      pending.resolve("stale remote read");
      await pending.promise;
    });
    expect(memoryEditor()).toHaveValue("local edits");
  });
});

describe("Hermes draft lifecycle", () => {
  it("retains newer edits during save and rejects completions after a reset", () => {
    const store = createHermesMemoryDraftStore();
    store.hydrate("memory", "initial");
    const generation = store.getState().generation;
    store.edit("memory", "submitted");
    store.edit("memory", "newer edit");
    store.markSaved("memory", "submitted", generation);
    expect(store.getState()).toMatchObject({
      draft: { memory: "newer edit" },
      saved: { memory: "submitted" },
    });
    store.reset();
    store.hydrate("memory", "reopened");
    store.markSaved("memory", "late completion", generation);
    expect(store.getState()).toMatchObject({
      draft: { memory: "reopened" },
      saved: { memory: "reopened" },
    });
  });
});
