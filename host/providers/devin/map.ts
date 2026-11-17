// Devin's ACP `session/update` records → NormalizedEvents. Pure and stateful per
// session: live and in history (session/load replays the same updates) alike.
//
// Shape of a run (docs: the spike traces): thought chunks, text chunks and tool
// calls interleave. One assistant message here is a run of blocks between two
// tool batches: a text or thought chunk that follows a finished tool opens a new
// message, as a new model call would.
import type { NormalizedEvent, ImageBlock, AssistantBlock, ModelInfo } from "../types.ts";

type Rec = Record<string, any>;

const TOOL_NAME_KEY = "cognition.ai/inferenceToolName";

function str(v: unknown): string | undefined {
  return typeof v === "string" ? v : undefined;
}
function num(v: unknown): number | undefined {
  return typeof v === "number" && Number.isFinite(v) ? v : undefined;
}

/** The text of an ACP content block (`{type:"text", text}`), or "" for anything else. */
function blockText(c: Rec | undefined): string {
  return c?.type === "text" && typeof c.text === "string" ? c.text : "";
}

/** The text of a tool's `content[]`: `{type:"content", content:{type:"text"}}` entries joined. */
export function toolText(content: unknown): string {
  if (!Array.isArray(content)) return "";
  const out: string[] = [];
  for (const c of content) {
    if (c?.type === "content") {
      const t = blockText(c.content);
      if (t) out.push(t);
    } else if (c?.type === "diff" && typeof c.path === "string") {
      out.push(`${c.path}`);
    }
  }
  return out.join("\n");
}

type OpenTool = { name: string; args: Rec; output: string; ended: boolean; started: boolean };

export type Usage = { used: number; size: number; input?: number; output?: number; cacheRead?: number };

export class DevinMapper {
  /** Replay (history) mode: events carry `ts`, and the user's messages come from `user_message_chunk`. */
  history: boolean;
  ts = 0;
  usage: Usage | null = null;
  title: string | null = null;
  private model: () => string | undefined;

  private content: (AssistantBlock | null)[] = [];
  private open: { index: number; kind: "text" | "thinking"; text: string } | null = null;
  private msgOpen = false;
  private toolsSinceText = false;
  private tools = new Map<string, OpenTool>();
  private userBuf = "";

  constructor(o: { history?: boolean; model: () => string | undefined }) {
    this.history = !!o.history;
    this.model = o.model;
  }

  reset(): void {
    this.content = [];
    this.open = null;
    this.msgOpen = false;
    this.toolsSinceText = false;
    this.tools.clear();
    this.userBuf = "";
  }

  /** A tool call seen so far (for an ask about it). */
  openTool(callId: string): { name: string; args: Rec } | undefined {
    const t = this.tools.get(callId);
    return t ? { name: t.name, args: t.args } : undefined;
  }

  private tag<T extends NormalizedEvent>(ev: T): T {
    return this.history && this.ts ? { ...ev, ts: this.ts } : ev;
  }

  private closeBlock(out: NormalizedEvent[]): void {
    if (!this.open) return;
    const { index, kind, text } = this.open;
    this.content[index] = { type: kind, text };
    out.push(this.tag({ type: "assistant_block_end", index, kind, text }));
    this.open = null;
  }

  /** Ends the open assistant message (its blocks, then `assistant_end`). */
  endMessage(out: NormalizedEvent[], stopReason?: "stop" | "aborted" | "error", error?: string): void {
    this.closeBlock(out);
    if (!this.msgOpen) return;
    const model = this.model();
    out.push(this.tag({ type: "assistant_end", content: this.content, stopReason, ...(error ? { error } : {}), ...(model ? { model } : {}) }));
    this.content = [];
    this.msgOpen = false;
    this.toolsSinceText = false;
  }

  private startMessage(out: NormalizedEvent[]): void {
    if (this.msgOpen) return;
    this.msgOpen = true;
    out.push(this.tag({ type: "assistant_start" }));
  }

  private chunk(kind: "text" | "thinking", text: string, out: NormalizedEvent[]): void {
    if (!text) return;
    // A chunk after a finished tool is a new model call.
    if (this.toolsSinceText && this.msgOpen && this.allToolsEnded()) this.endMessage(out, "stop");
    this.startMessage(out);
    if (this.open && this.open.kind !== kind) this.closeBlock(out);
    if (!this.open) {
      const index = this.content.length;
      this.content.push(null);
      this.open = { index, kind, text: "" };
      out.push(this.tag({ type: "assistant_block_start", index, kind }));
    }
    this.open.text += text;
    out.push(this.tag({ type: "assistant_delta", index: this.open.index, kind, delta: text }));
    if (kind === "text") this.toolsSinceText = false;
  }

  private allToolsEnded(): boolean {
    for (const t of this.tools.values()) if (!t.ended) return false;
    return true;
  }

  /** The user's message in a replay: chunks accumulate until the next non-user update. */
  private flushUser(out: NormalizedEvent[]): void {
    if (!this.userBuf) return;
    out.push(this.tag({ type: "user_message", text: this.userBuf, images: 0 }));
    this.userBuf = "";
  }

  private toolName(u: Rec): string {
    return str(u._meta?.[TOOL_NAME_KEY]) ?? str(u.kind) ?? str(u.title) ?? "tool";
  }

  private toolArgs(u: Rec, name: string): Rec {
    const raw: Rec = u.rawInput && typeof u.rawInput === "object" ? { ...u.rawInput } : {};
    if (!Object.keys(raw).length) {
      // `read` and the like name their target only in `locations`.
      const loc = str(u.locations?.[0]?.path);
      if (loc) raw.path = loc;
      const preview = u.content?.find?.((c: Rec) => c?.content?.resource?.text)?.content?.resource?.text;
      if (typeof preview === "string" && name === "exec") raw.command = preview;
    }
    return raw;
  }

  /** One `session/update`'s `update` object. */
  update(u: Rec): NormalizedEvent[] {
    const out: NormalizedEvent[] = [];
    const kind = str(u.sessionUpdate);
    if (kind !== "user_message_chunk") this.flushUser(out);
    switch (kind) {
      case "user_message_chunk":
        if (this.history) {
          this.endMessage(out, "stop");
          this.userBuf += blockText(u.content);
        }
        break;
      case "agent_message_chunk":
        this.chunk("text", blockText(u.content), out);
        break;
      case "agent_thought_chunk":
        this.chunk("thinking", blockText(u.content), out);
        break;
      case "tool_call": {
        const id = str(u.toolCallId);
        if (!id) break;
        this.closeBlock(out);
        this.startMessage(out);
        const name = this.toolName(u);
        const args = this.toolArgs(u, name);
        const index = this.content.length;
        this.content.push({ type: "toolCall", callId: id, name, args });
        this.tools.set(id, { name, args, output: "", ended: false, started: true });
        this.toolsSinceText = true;
        out.push(this.tag({ type: "tool_call", index, callId: id, name, args }));
        out.push(this.tag({ type: "tool_started", callId: id, name, args }));
        break;
      }
      case "tool_call_update": {
        const id = str(u.toolCallId);
        const t = id ? this.tools.get(id) : undefined;
        if (!id || !t || t.ended) break;
        const text = toolText(u.content);
        if (text) t.output = text;
        const status = str(u.status);
        const exit = u._meta?.terminal_exit;
        const exitCode = num(exit?.exit_code);
        if (status === "completed" || status === "failed") {
          t.ended = true;
          const rejected = !!u._meta?.["cognition.ai/rejected"];
          const result: Rec = exitCode !== undefined ? { exitCode } : {};
          out.push(this.tag({
            type: "tool_ended", callId: id, name: t.name, args: t.args,
            isError: status === "failed" || (exitCode !== undefined && exitCode !== 0),
            ...(rejected ? { declined: true } : {}),
            output: t.output, result,
          }));
        } else if (text) {
          out.push(this.tag({ type: "tool_progress", callId: id, name: t.name, args: t.args, output: t.output }));
        }
        break;
      }
      case "usage_update": {
        const used = num(u.used);
        const size = num(u.size);
        if (used !== undefined && size !== undefined) {
          this.usage = { used, size, input: num(u._meta?.["cognition.ai/inputTokens"]), output: num(u._meta?.["cognition.ai/outputTokens"]), cacheRead: num(u._meta?.["cognition.ai/cachedReadTokens"]) };
          out.push(this.tag({ type: "turn_end" }));
        }
        break;
      }
      case "session_info_update":
        if (typeof u.title === "string") {
          this.title = u.title;
          out.push(this.tag({ type: "session", name: u.title }));
        }
        break;
      case "current_mode_update":
        if (typeof u.currentModeId === "string") out.push(this.tag({ type: "permission_mode", mode: u.currentModeId }));
        break;
      default:
        // available_commands_update, config_option_update: the adapter reads those itself.
        break;
    }
    if (out.length && !this.history) out.unshift({ type: "heartbeat" });
    return out;
  }

  /** The run is over (the prompt's reply, or a cancel). Ends any open message. */
  settle(stopReason: string | undefined, error?: string): NormalizedEvent[] {
    const out: NormalizedEvent[] = [];
    this.flushUser(out);
    const aborted = stopReason === "cancelled";
    // A tool still open when the run ends was cut off.
    for (const [id, t] of this.tools) {
      if (t.ended) continue;
      t.ended = true;
      out.push(this.tag({ type: "tool_ended", callId: id, name: t.name, args: t.args, isError: true, declined: aborted, output: t.output || (aborted ? "Cancelled" : ""), result: {} }));
    }
    this.endMessage(out, aborted ? "aborted" : error ? "error" : "stop", error);
    this.tools.clear();
    return out;
  }
}

export function modelInfoOf(opt: Rec): ModelInfo {
  return {
    provider: "devin", id: String(opt.value), name: String(opt.name ?? opt.value), reasoning: false, contextWindow: null,
    input: opt._meta?.["cognition.ai/supportsImages"] ? ["text", "image"] : ["text"],
  };
}

export type { ImageBlock };
