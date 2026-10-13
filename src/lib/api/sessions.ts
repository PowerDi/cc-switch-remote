import { Channel, invoke } from "@tauri-apps/api/core";
import type {
  ContentRef,
  ImageRef,
  SessionMessage,
  SessionMeta,
  TranscriptChunk,
} from "@/types";
import { remoteApi, type ManagementTarget } from "./remote";

/**
 * v4 的分块/图片/导出读取链依赖桌面端专有的 tauri Channel 与 IPC 字节返回，
 * 远端只有 list/getMessages 的 JSON 通道。远端调用这些方法直接报错，
 * 让上层隐藏/降级，而不是拿本机文件当成远端会话。
 */
const requireLocalSessionTarget = (
  method: string,
  target: ManagementTarget,
) => {
  if (target.type === "remote") {
    throw new Error(
      `${method} is local-only; remote sessions only support list and getMessages`,
    );
  }
};

export interface DeleteSessionOptions {
  providerId: string;
  sessionId: string;
  sourcePath: string;
}

export interface DeleteSessionResult extends DeleteSessionOptions {
  success: boolean;
  error?: string;
}

/** get_session_block_content 的返回：按字符分页取工具输出 / 参数 / 思考 / diff 全文 */
export interface BlockContent {
  text: string;
  /** 全文字符数 */
  totalLen: number;
  /** 本页之后还有内容 */
  truncated: boolean;
  /** 下一页的起始字符偏移 */
  nextOffset?: number;
}

export interface BlockContentPage {
  offset?: number;
  limit?: number;
}

export const sessionsApi = {
  async list(
    target: ManagementTarget = { type: "local" },
  ): Promise<SessionMeta[]> {
    if (target.type === "remote") {
      return await remoteApi.listSessions(target.profile, target.secret);
    }
    return await invoke("list_sessions");
  },

  async getMessages(
    providerId: string,
    sourcePath: string,
    target: ManagementTarget = { type: "local" },
  ): Promise<SessionMessage[]> {
    if (target.type === "remote") {
      return await remoteApi.getSessionMessages(
        target.profile,
        providerId,
        sourcePath,
        target.secret,
      );
    }
    return await invoke("get_session_messages", { providerId, sourcePath });
  },

  async delete(
    options: DeleteSessionOptions,
    target: ManagementTarget = { type: "local" },
  ): Promise<boolean> {
    if (target.type === "remote") {
      return await remoteApi.deleteSession(
        target.profile,
        options,
        target.secret,
      );
    }
    const { providerId, sessionId, sourcePath } = options;
    return await invoke("delete_session", {
      providerId,
      sessionId,
      sourcePath,
    });
  },

  /**
   * 分块读取会话（stream_session_messages）：后端先推 Header，再按批推 Messages，
   * 最后 Done；失败时先推 Error 再以同一文案 reject。
   */
  async streamMessages(
    providerId: string,
    sourcePath: string,
    onChunk: (chunk: TranscriptChunk) => void,
    target: ManagementTarget = { type: "local" },
  ): Promise<void> {
    requireLocalSessionTarget("streamMessages", target);
    const channel = new Channel<TranscriptChunk>();
    channel.onmessage = onChunk;
    await invoke("stream_session_messages", {
      providerId,
      sourcePath,
      onChunk: channel,
    });
  },

  /** 按 ContentRef 取全文（引用原样回传，前端不解析）；按字符分页，每页最多 512K 字符 */
  async getBlockContent(
    providerId: string,
    sourcePath: string,
    contentRef: ContentRef,
    page: BlockContentPage = {},
    target: ManagementTarget = { type: "local" },
  ): Promise<BlockContent> {
    requireLocalSessionTarget("getBlockContent", target);
    return await invoke("get_session_block_content", {
      providerId,
      sourcePath,
      contentRef,
      offset: page.offset,
      limit: page.limit,
    });
  },

  /** 取图片原始字节（后端返回 tauri::ipc::Response），调用方按 mediaType 转 Blob；SVG 会被后端拒绝 */
  async getImage(
    providerId: string,
    sourcePath: string,
    image: ImageRef,
    target: ManagementTarget = { type: "local" },
  ): Promise<ArrayBuffer> {
    requireLocalSessionTarget("getImage", target);
    return await invoke("get_session_image", {
      providerId,
      sourcePath,
      image,
    });
  },

  /** 在 Finder / 文件管理器中显示本地路径（绝对路径或 file://，决策 D3） */
  async revealPath(
    path: string,
    target: ManagementTarget = { type: "local" },
  ): Promise<boolean> {
    requireLocalSessionTarget("revealPath", target);
    return await invoke("reveal_session_path", { path });
  },

  /** 弹出保存对话框把会话存成 Markdown 文件；取消时返回 null，成功返回保存路径 */
  async exportMarkdown(
    defaultName: string,
    content: string,
    target: ManagementTarget = { type: "local" },
  ): Promise<string | null> {
    requireLocalSessionTarget("exportMarkdown", target);
    return await invoke("export_session_markdown", { defaultName, content });
  },

  async deleteMany(
    items: DeleteSessionOptions[],
    target: ManagementTarget = { type: "local" },
  ): Promise<DeleteSessionResult[]> {
    if (target.type === "remote") {
      return await remoteApi.deleteSessions(
        target.profile,
        items,
        target.secret,
      );
    }
    return await invoke("delete_sessions", { items });
  },

  async launchTerminal(options: {
    command: string;
    cwd?: string | null;
    customConfig?: string | null;
  }): Promise<boolean> {
    const { command, cwd, customConfig } = options;
    return await invoke("launch_session_terminal", {
      command,
      cwd,
      customConfig,
    });
  },
};
