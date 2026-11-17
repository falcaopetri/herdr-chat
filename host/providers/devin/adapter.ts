// Devin as a provider: `devin acp` (Agent Client Protocol, JSON-RPC over stdio),
// one process per chat. ACP sessions are sessions, `session/prompt` is a run
// (it replies when the run ends), `session/update` notifications are the events
// (mapped by map.ts, live and in history alike). This file owns the run
// lifecycle, the follow-up queue (Devin has no steer), permission asks,
// settings (model, mode) and sessions.
//
// What ACP doesn't give: steering a running turn, fork, separate thinking
// levels, cost. `tui` is a plain `devin --resume <id>` hand-off.
import { basename } from "node:path";
import { AcpProcess, AcpRpcError } from "./rpc.ts";
import type { RequestId } from "./rpc.ts";
import { DevinMapper, modelInfoOf } from "./map.ts";
import { DEVIN_TOOLS } from "./tools.ts";
import { agentEnv } from "../env.ts";
import { AgentError } from "../types.ts";
import type {
  ProviderAdapter, AdapterHost, AdapterOptions, Capabilities, StartInfo, NormalizedEvent, AskAnswer, ImageBlock, Ask,
  AgentCommand, AgentModel, SessionInfo, SessionScope, SessionSource, UsageInfo, PromptMode, Disposition, PermissionMode, PermissionChoice,
} from "../types.ts";

type Rec = Record<string, any>;

const PROTOCOL_VERSION = 1;

function str(v: unknown): string | undefined {
  return typeof v === "string" ? v : undefined;
}
/** A session reference → Devin's session id. The core hands sessions around as file paths (resolved against the folder), and Devin's ids ("popular-puck") are bare words. */
export function sessionIdOf(ref: string): string {
  return basename(ref);
}
function errText(e: unknown): string {
  return e instanceof Error ? e.message : String(e);
}

type OpenAsk = { rpcId: RequestId; options: Rec[] };

export class DevinAdapter implements ProviderAdapter {
  readonly id = "devin";
  readonly name = "Devin";
  readonly tools = DEVIN_TOOLS;
  readonly capabilities: Capabilities = {
    steer: false, followUp: true, thinkingLevels: [], permissions: true, permissionModes: [],
    extensionUi: false, compact: false, compactInstructions: false, rename: false, fork: false, images: false, cost: false, tui: true,
  };
  private opts: AdapterOptions;
  private proc: AcpProcess | null = null;
  private dying: AcpProcess | null = null;
  private host: AdapterHost | null = null;
  private mapper: DevinMapper;

  private session: string | null = null;
  /** No prompt yet: nothing saved to resume or list. */
  private fresh = true;
  private modelOptions: Rec[] = [];
  private currentModel: string | null = null;
  private modes: PermissionMode[] = [];
  private commandList: AgentCommand[] = [];
  /** Events of a session/load replay, for `history()`. */
  private replay: DevinMapper | null = null;
  private replayEvents: NormalizedEvent[] = [];

  // ---- run state
  private runOpen = false;
  private aborting = false;
  private followUps: { id: string; text: string; images: ImageBlock[] }[] = [];
  private asks = new Map<string, OpenAsk>();

  constructor(opts: AdapterOptions) {
    this.opts = opts;
    this.mapper = new DevinMapper({ model: () => this.modelRef() });
  }

  get alive(): boolean {
    return !!this.proc && !this.proc.exited;
  }

  private emit(ev: NormalizedEvent): void {
    this.host?.emit(ev);
  }

  private require(): AcpProcess {
    if (!this.proc || this.proc.exited) throw new AgentError("Devin is not running. Use /reload to restart it.");
    return this.proc;
  }

  private requireSession(): string {
    if (!this.session) throw new AgentError("Devin has no session open. Use /reload to restart it.");
    return this.session;
  }

  private modelRef(): string | undefined {
    return this.currentModel ? `devin/${this.currentModel}` : undefined;
  }

  // ---------------------------------------------------------------- lifecycle

  async start(session: string | null, host: AdapterHost): Promise<StartInfo> {
    this.host = host;
    this.resetRun();
    this.asks.clear();
    const args = [...this.opts.args, "acp"];
    host.log(`spawn ${this.opts.command} ${args.join(" ")}`);
    const proc = new AcpProcess({ command: this.opts.command, args, cwd: this.opts.cwd, env: agentEnv() });
    this.proc = proc;
    proc.onNotification = (m, p) => this.proc === proc && this.onNotification(m, p);
    proc.onServerRequest = (id, m, p) => this.proc === proc && this.onServerRequest(id, m, p);
    proc.onBadLine = (line) => host.log(`devin stdout (not JSON-RPC): ${line.slice(0, 200)}`);
    proc.onOversized = (o) => {
      if (this.proc !== proc) return;
      host.log(`dropped an oversized Devin record (${o.size} bytes): ${o.head.slice(0, 120)}`);
      this.emit({ type: "notice", level: "warning", source: "host", text: `Devin sent an update too large to show (${(o.size / 1048576).toFixed(1)} MiB), so part of this turn is missing here.`, once: "run" });
    };
    proc.onExit = (info) => {
      if (this.proc !== proc) return;
      this.proc = null;
      this.resetRun();
      host.emit({
        type: "exited", code: info.code, signal: info.signal, stderrTail: info.stderr,
        ...(info.spawnError ? { spawnError: info.spawnError } : {}), command: this.opts.command,
      });
    };

    const init = await proc.request("initialize", { protocolVersion: PROTOCOL_VERSION, clientCapabilities: {} }, 30_000);
    const v = str(init?.agentInfo?.version);
    this.emit({ type: "version", version: v && v !== "0.0.0-dev" ? v : null });
    const img = init?.agentCapabilities?.promptCapabilities?.image === true;
    this.emit({ type: "capabilities", capabilities: { images: img } });
    const resumed = await this.openSession(session);
    return { streaming: false, hasHistory: resumed };
  }

  /** `session/load` (resume) or `session/new`. Returns whether a session was resumed. */
  private async openSession(session: string | null): Promise<boolean> {
    const proc = this.require();
    if (session) {
      session = sessionIdOf(session);
      this.replay = new DevinMapper({ history: true, model: () => this.modelRef() });
      this.replayEvents = [];
      this.session = session;
      try {
        const r = await proc.request("session/load", { sessionId: session, cwd: this.opts.cwd, mcpServers: [] }, 120_000);
        this.replayEvents.push(...this.replay.settle(undefined));
        this.replay = null;
        this.applySession(session, r, true);
        return true;
      } catch (e) {
        this.replay = null;
        this.session = null;
        if (/already open in another process/i.test(errText(e))) {
          throw new AgentError("This Devin session is open in another Devin process. Close it there (or its terminal), then use /reload.", false, true);
        }
        if (!/not found|no such|unknown session|does not exist/i.test(errText(e))) throw e;
        this.emit({ type: "notice", level: "warning", source: "host", text: `Could not resume the Devin session (${errText(e)}); started a new one.` });
      }
    }
    const r = await proc.request("session/new", { cwd: this.opts.cwd, mcpServers: [] }, 60_000);
    this.applySession(str(r?.sessionId) ?? "", r, false);
    return false;
  }

  private applySession(id: string, r: Rec, resumed: boolean): void {
    this.session = id || null;
    this.fresh = !resumed;
    this.mapper.reset();
    // A new session is saved at its first prompt; until then there is nothing to resume.
    this.emit({ type: "session", id: this.session, file: resumed ? this.session : null, name: this.mapper.title ?? null });
    this.applyConfig(Array.isArray(r?.configOptions) ? r.configOptions : []);
    const mode = str(r?.modes?.currentModeId);
    if (!this.modes.length && Array.isArray(r?.modes?.availableModes)) {
      this.modes = r.modes.availableModes.map((m: Rec) => ({ id: String(m.id), label: String(m.name ?? m.id), ...(str(m.description) ? { description: m.description } : {}) }));
      this.emit({ type: "capabilities", capabilities: { permissionModes: this.modes } });
    }
    if (mode) this.emit({ type: "permission_mode", mode });
  }

  /** `configOptions` (mode and model are selects) → modes, models, events. */
  private applyConfig(opts: Rec[]): void {
    for (const o of opts) {
      if (o?.id === "model" && Array.isArray(o.options)) {
        this.modelOptions = o.options;
        this.currentModel = str(o.currentValue) ?? this.currentModel;
        const cur = this.modelOptions.find((m) => m.value === this.currentModel);
        if (cur) {
          const info = modelInfoOf(cur);
          this.emit({ type: "model", model: { ...info, contextWindow: this.mapper.usage?.size ?? null } });
          this.emit({ type: "capabilities", capabilities: { images: info.input.includes("image") } });
        }
      } else if (o?.id === "mode" && Array.isArray(o.options)) {
        this.modes = o.options.map((m: Rec) => ({ id: String(m.value), label: String(m.name ?? m.value), ...(str(m.description) ? { description: m.description } : {}) }));
        this.emit({ type: "capabilities", capabilities: { permissionModes: this.modes } });
        if (str(o.currentValue)) this.emit({ type: "permission_mode", mode: o.currentValue });
      }
    }
  }

  watchRun(): void {
    this.runOpen = true;
  }

  async dispose(): Promise<void> {
    const p = this.proc;
    if (!p) return;
    this.proc = null;
    this.dying = p;
    this.resetRun();
    // `devin acp` ignores EOF on stdin (it exits on SIGTERM), so there is little to wait for.
    await p.stop(150);
    this.dying = null;
  }

  // Also the process dispose() is still stopping: the host's exit handler must not leave it running (it holds the session).
  kill(): void {
    (this.proc ?? this.dying)?.killNow();
  }

  private resetRun(): void {
    this.runOpen = false;
    this.aborting = false;
    this.followUps = [];
    this.mapper.reset();
  }

  // ---------------------------------------------------------------- notifications

  private onNotification(method: string, p: Rec): void {
    if (method !== "session/update") return; // _cognition.ai/* extras: the prompt's reply carries what we need
    const sid = str(p.sessionId);
    if (sid && this.session && sid !== this.session) return;
    const u: Rec = p.update ?? {};
    if (this.replay) {
      this.replayEvents.push(...this.replay.update(u));
      return;
    }
    switch (u.sessionUpdate) {
      case "available_commands_update":
        this.commandList = (Array.isArray(u.availableCommands) ? u.availableCommands : []).map((c: Rec) => ({
          name: String(c.name), description: String(c.description ?? "").slice(0, 200), source: "skill" as const,
        }));
        return;
      case "config_option_update":
        this.applyConfig(Array.isArray(u.configOptions) ? u.configOptions : []);
        return;
    }
    for (const ev of this.mapper.update(u)) this.emit(ev);
    if (u.sessionUpdate === "usage_update" && this.currentModel) this.applyConfig([{ id: "model", options: this.modelOptions, currentValue: this.currentModel }]);
  }

  // ---------------------------------------------------------------- asks

  private onServerRequest(id: RequestId, method: string, p: Rec): void {
    const proc = this.proc;
    if (!proc) return;
    if (method !== "session/request_permission") {
      proc.respondError(id, -32601, `${method} is not supported by herdr-chat`);
      return;
    }
    const askId = String(id);
    const options: Rec[] = Array.isArray(p.options) ? p.options : [];
    this.asks.set(askId, { rpcId: id, options });
    const callId = str(p.toolCall?.toolCallId);
    const open = callId ? this.mapper.openTool(callId) : undefined;
    const choices: PermissionChoice[] = options.map((o) => ({
      id: String(o.optionId), label: String(o.name ?? o.optionId),
      kind: o.kind === "allow_once" ? "allow" : o.kind === "allow_always" ? "allow_always" : o.kind === "reject_once" || o.kind === "reject_always" ? "deny" : "other",
    }));
    const ask: Ask = {
      id: askId, kind: "permission",
      title: open?.name === "exec" ? "Run this command?" : "Allow this action?",
      ...(open ? { tool: { name: open.name, args: open.args, callId } } : {}),
      choices,
    };
    this.emit({ type: "ask", ask });
  }

  answer(askId: string, a: AskAnswer): void {
    const open = this.asks.get(askId);
    const proc = this.proc;
    if (!open || !proc) return;
    this.asks.delete(askId);
    if ("cancelled" in a) {
      proc.respond(open.rpcId, { outcome: { outcome: "cancelled" } });
      return;
    }
    const choice = "choice" in a ? a.choice : null;
    const pick = open.options.find((o) => String(o.optionId) === choice) ?? open.options.find((o) => o.kind === "reject_once");
    proc.respond(open.rpcId, pick ? { outcome: { outcome: "selected", optionId: String(pick.optionId) } } : { outcome: { outcome: "cancelled" } });
  }

  // ---------------------------------------------------------------- turns

  async prompt(p: { id: string; text: string; images: ImageBlock[]; mode: PromptMode; busy: boolean }): Promise<{ disposition: Disposition }> {
    this.require();
    if (p.busy || this.runOpen) {
      // No steer in ACP: a message mid-run waits for the run to end.
      this.followUps.push({ id: p.id, text: p.text, images: p.images });
      this.emitQueue();
      return { disposition: "queued" };
    }
    this.sendTurn(p.text, p.images, p.id);
    return { disposition: "started" };
  }

  private buildPrompt(text: string, images: ImageBlock[]): Rec[] {
    return [...images.map((i) => ({ type: "image", data: i.data, mimeType: i.mimeType })), { type: "text", text }];
  }

  /** Starts a run: `session/prompt` replies when it ends. Not awaited by `prompt`. */
  private sendTurn(text: string, images: ImageBlock[], clientId: string): void {
    const proc = this.require();
    const session = this.requireSession();
    this.runOpen = true;
    this.aborting = false;
    this.emit({ type: "run_started" });
    this.emit({ type: "user_message", text, images: images.length, clientId });
    if (this.fresh) {
      this.fresh = false;
      this.emit({ type: "session", file: session });
    }
    proc.request("session/prompt", { sessionId: session, prompt: this.buildPrompt(text, images) }, 0)
      .then((r) => this.onTurnDone(str(r?.stopReason), undefined), (e) => this.onTurnDone(undefined, e))
      .catch((e) => this.host?.log(`turn end failed: ${errText(e)}`));
  }

  private onTurnDone(stopReason: string | undefined, err: unknown): void {
    const aborted = stopReason === "cancelled" || this.aborting;
    const error = err ? errText(err) : stopReason === "refusal" ? "Devin refused this request" : undefined;
    for (const ev of this.mapper.settle(aborted ? "cancelled" : stopReason, error)) this.emit(ev);
    if (error && !(err instanceof AcpRpcError && err.agentExited)) this.emit({ type: "notice", level: "error", source: "host", text: `Devin: ${error}` });
    this.aborting = false;
    const next = aborted ? undefined : this.followUps.shift();
    if (next) {
      this.emitQueue();
      this.sendTurn(next.text, next.images, next.id);
      return;
    }
    this.runOpen = false;
    this.emit({ type: "run_settled", aborted });
  }

  private emitQueue(): void {
    this.emit({
      type: "queue_changed", steering: [], followUp: this.followUps.map((f) => f.text),
      steeringIds: [], followUpIds: this.followUps.map((f) => f.id),
    });
  }

  async clearQueue(): Promise<string[]> {
    const out = this.followUps.map((f) => f.text);
    this.followUps = [];
    if (out.length) this.emitQueue();
    return out;
  }

  canRemoveQueued(id: string): boolean {
    return this.followUps.some((f) => f.id === id);
  }

  async removeQueued(id: string): Promise<boolean> {
    const i = this.followUps.findIndex((f) => f.id === id);
    if (i < 0) return false;
    this.followUps.splice(i, 1);
    this.emitQueue();
    return true;
  }

  abort(): void {
    if (!this.proc || !this.session) return;
    this.aborting = true;
    // Open asks are cancelled, as ACP asks for.
    for (const [id, a] of this.asks) {
      this.proc.respond(a.rpcId, { outcome: { outcome: "cancelled" } });
      this.emit({ type: "ask_closed", id });
    }
    this.asks.clear();
    this.proc.notify("session/cancel", { sessionId: this.session });
  }

  // ---------------------------------------------------------------- queries

  async history(): Promise<NormalizedEvent[]> {
    this.requireSession();
    const out = this.replayEvents;
    this.replayEvents = [];
    return out;
  }

  readonly sessions: SessionSource = {
    kind: "agent",
    list: async (scope: SessionScope): Promise<SessionInfo[]> => {
      const r = await this.require().request("session/list", scope === "cwd" ? { cwd: this.opts.cwd } : {}, 30_000);
      const list: Rec[] = Array.isArray(r?.sessions) ? r.sessions : [];
      return list
        .filter((s) => str(s.sessionId) && s.title !== "Untitled")
        .map((s) => ({
          path: String(s.sessionId), name: null, firstMessage: str(s.title) ?? "",
          modified: Date.parse(String(s.updatedAt)) || 0, messageCount: null, cwd: str(s.cwd) ?? null,
        }));
    },
  };

  async listModels(): Promise<AgentModel[]> {
    return this.modelOptions.map((m) => ({ provider: "devin", id: String(m.value), name: String(m.name ?? m.value), reasoning: false, enabled: true }));
  }

  async commands(): Promise<AgentCommand[]> {
    return this.commandList;
  }

  async usage(): Promise<UsageInfo> {
    const u = this.mapper.usage;
    if (!u) return { contextTokens: null, contextWindow: null, percent: null, cost: null };
    return { contextTokens: u.used, contextWindow: u.size, percent: u.size ? Math.round((u.used / u.size) * 1000) / 10 : null, cost: null };
  }

  tuiCommand(session: string): string[] {
    return [this.opts.command, ...this.opts.args, "--resume", sessionIdOf(session) || this.session || ""];
  }

  // ---------------------------------------------------------------- settings

  async setModel(_provider: string, id: string): Promise<void> {
    const m = this.modelOptions.find((o) => o.value === id);
    if (this.modelOptions.length && !m) throw new Error(`Devin has no model "${id}"`);
    const proc = this.require();
    const sessionId = this.requireSession();
    try {
      await proc.request("session/set_config_option", { sessionId, configId: "model", value: id }, 30_000);
    } catch (e) {
      if (!(e instanceof AcpRpcError) || e.code !== -32601) throw e;
      await proc.request("session/set_model", { sessionId, modelId: id }, 30_000);
    }
    this.currentModel = id;
    this.applyConfig([{ id: "model", options: this.modelOptions, currentValue: id }]);
  }

  async setThinking(_level: string): Promise<void> {
    throw new Error("Devin has no thinking levels");
  }

  async setPermissionMode(mode: string): Promise<void> {
    if (!this.modes.some((m) => m.id === mode)) throw new Error(`Unknown permission mode "${mode}"`);
    const proc = this.require();
    const sessionId = this.requireSession();
    try {
      await proc.request("session/set_mode", { sessionId, modeId: mode }, 30_000);
    } catch (e) {
      if (!(e instanceof AcpRpcError) || e.code !== -32601) throw e;
      await proc.request("session/set_config_option", { sessionId, configId: "mode", value: mode }, 30_000);
    }
    this.emit({ type: "permission_mode", mode });
  }

  async compact(): Promise<void> {
    throw new Error("Devin's /compact isn't available in the chat yet");
  }

  async newSession(): Promise<void> {
    const proc = this.require();
    this.resetRun();
    const r = await proc.request("session/new", { cwd: this.opts.cwd, mcpServers: [] }, 60_000);
    this.applySession(str(r?.sessionId) ?? "", r, false);
  }

  async switchSession(ref: string): Promise<void> {
    const path = sessionIdOf(ref);
    const proc = this.require();
    this.resetRun();
    this.replay = new DevinMapper({ history: true, model: () => this.modelRef() });
    this.replayEvents = [];
    this.session = path;
    try {
      const r = await proc.request("session/load", { sessionId: path, cwd: this.opts.cwd, mcpServers: [] }, 120_000);
      this.replayEvents.push(...this.replay.settle(undefined));
      this.applySession(path, r, true);
    } catch (e) {
      if (/already open in another process/i.test(errText(e))) throw new AgentError("That Devin session is open in another Devin process. Close it there first.", false, true);
      throw e;
    } finally {
      this.replay = null;
    }
  }

  async setName(_name: string): Promise<void> {
    throw new Error("Devin sessions can't be renamed from the chat yet");
  }
}
