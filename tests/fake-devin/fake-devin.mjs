#!/usr/bin/env node
// fake-devin: a scriptable stand-in for `devin acp` (ACP, JSON-RPC 2.0 over
// LF-framed JSONL on stdio). Node, no dependencies. Prompts by their text:
//   "ask ..."   an exec that needs approval (session/request_permission), then text
//   "run ..."   an exec (exit 0), then text
//   "slow ..."  thinks, then waits for session/cancel
//   anything else: a text reply "Echo: <prompt>"
// FAKE_DEVIN_LOG: every message the host sent, as JSONL.
import { appendFileSync, writeFileSync } from "node:fs";
import { createInterface } from "node:readline";

const LOG = process.env.FAKE_DEVIN_LOG;
const sessions = new Map(); // id → { cwd, title, history: [{role,text}] }
let n = 0;
// FAKE_DEVIN_SEED=id: a saved session with one exchange (a resume across hosts).
if (process.env.FAKE_DEVIN_SEED) sessions.set(process.env.FAKE_DEVIN_SEED, { cwd: process.cwd(), title: "Earlier", history: [{ role: "user", text: "first question" }, { role: "agent", text: "first answer" }], updatedAt: new Date().toISOString() });
let nextReq = 1;
const pending = new Map();
let cancel = null;

const send = (m) => process.stdout.write(JSON.stringify({ jsonrpc: "2.0", ...m }) + "\n");
const update = (sessionId, u) => send({ method: "session/update", params: { sessionId, update: u } });
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const configOptions = (model = "fake-fast") => [
  { id: "mode", name: "Session Mode", category: "mode", type: "select", currentValue: "accept-edits", options: [
    { value: "accept-edits", name: "Code", description: "Write and edit code" }, { value: "ask", name: "Ask" }, { value: "plan", name: "Plan" }, { value: "bypass", name: "Bypass Permissions" } ] },
  { id: "model", name: "Model", category: "model", type: "select", currentValue: model, options: [
    { value: "fake-fast", name: "Fake Fast", _meta: { "cognition.ai/supportsImages": false } }, { value: "fake-slow", name: "Fake Slow", _meta: { "cognition.ai/supportsImages": true } } ] },
];
const sessionResult = (id) => ({ sessionId: id, modes: { currentModeId: "accept-edits", availableModes: [{ id: "accept-edits", name: "Code" }, { id: "ask", name: "Ask" }] }, configOptions: configOptions() });

function request(method, params) {
  const id = `srv-${nextReq++}`;
  return new Promise((resolve) => {
    pending.set(id, resolve);
    send({ id, method, params });
  });
}

async function runPrompt(id, text) {
  const s = sessions.get(id);
  s.history.push({ role: "user", text });
  if (!s.title) {
    s.title = text.slice(0, 40);
    update(id, { sessionUpdate: "session_info_update", title: s.title });
  }
  cancel = null;
  const cancelled = () => cancel !== null;
  const reply = async (t) => {
    update(id, { sessionUpdate: "agent_message_chunk", content: { type: "text", text: t } });
    s.history.push({ role: "agent", text: t });
  };
  if (/^slow/.test(text)) {
    update(id, { sessionUpdate: "agent_thought_chunk", content: { type: "text", text: "Taking my time." } });
    for (let i = 0; i < 200 && !cancelled(); i++) await sleep(25);
    return { stopReason: cancelled() ? "cancelled" : "end_turn" };
  }
  if (/^(ask|run)/.test(text)) {
    const callId = `call_${++n}`;
    const command = text.replace(/^(ask|run)\s*/, "") || "echo hi";
    update(id, { sessionUpdate: "tool_call", toolCallId: callId, title: "Ran command", kind: "execute", rawInput: { command }, _meta: { "cognition.ai/inferenceToolName": "exec" } });
    if (/^ask/.test(text)) {
      const r = await request("session/request_permission", { sessionId: id, toolCall: { toolCallId: callId }, options: [
        { optionId: "allow_once", name: "Allow", kind: "allow_once" }, { optionId: "allow_always", name: "Always allow", kind: "allow_always" }, { optionId: "reject_once", name: "Reject", kind: "reject_once" } ] });
      if (r?.outcome?.optionId === "reject_once" || r?.outcome?.outcome === "cancelled") {
        update(id, { sessionUpdate: "tool_call_update", toolCallId: callId, status: "failed", content: [{ type: "content", content: { type: "text", text: "Tool execution was rejected" } }], _meta: { "cognition.ai/inferenceToolName": "exec", "cognition.ai/rejected": true } });
        await reply("Denied.");
        return { stopReason: "end_turn" };
      }
    }
    update(id, { sessionUpdate: "tool_call_update", toolCallId: callId, status: "in_progress", content: [{ type: "content", content: { type: "text", text: "out\n" } }], _meta: { "cognition.ai/inferenceToolName": "exec" } });
    update(id, { sessionUpdate: "tool_call_update", toolCallId: callId, status: "completed", content: [{ type: "content", content: { type: "text", text: "out\n" } }], _meta: { "cognition.ai/inferenceToolName": "exec", terminal_exit: { exit_code: 0, signal: null } } });
    await reply("Done.");
  } else {
    await reply(`Echo: ${text}`);
  }
  update(id, { sessionUpdate: "usage_update", used: 1000, size: 100000 });
  return { stopReason: "end_turn", usage: { totalTokens: 1000 } };
}

async function handle(m) {
  const p = m.params ?? {};
  switch (m.method) {
    case "initialize":
      return send({ id: m.id, result: { protocolVersion: 1, agentCapabilities: { loadSession: true, promptCapabilities: { image: true } }, agentInfo: { name: "fake-devin", version: "1.2.3" } } });
    case "session/new": {
      const id = `fake-session-${++n}`;
      sessions.set(id, { cwd: p.cwd, title: null, history: [], updatedAt: new Date().toISOString() });
      send({ id: m.id, result: sessionResult(id) });
      return update(id, { sessionUpdate: "available_commands_update", availableCommands: [{ name: "help", description: "Show help" }] });
    }
    case "session/load": {
      const s = sessions.get(p.sessionId);
      if (!s) return send({ id: m.id, error: { code: -32602, message: `session ${p.sessionId} not found` } });
      for (const h of s.history) update(p.sessionId, { sessionUpdate: h.role === "user" ? "user_message_chunk" : "agent_message_chunk", content: { type: "text", text: h.text } });
      return send({ id: m.id, result: sessionResult(p.sessionId) });
    }
    case "session/list":
      return send({ id: m.id, result: { sessions: [...sessions].map(([sessionId, s]) => ({ sessionId, cwd: s.cwd, title: s.title ?? "Untitled", updatedAt: s.updatedAt })) } });
    case "session/prompt": {
      const text = (p.prompt ?? []).filter((b) => b.type === "text").map((b) => b.text).join("\n");
      const r = await runPrompt(p.sessionId, text);
      return send({ id: m.id, result: r });
    }
    case "session/cancel":
      cancel = true;
      return;
    case "session/set_mode":
    case "session/set_config_option":
      return send({ id: m.id, result: {} });
    default:
      if (m.id !== undefined) send({ id: m.id, error: { code: -32601, message: `unknown method ${m.method}` } });
  }
}

createInterface({ input: process.stdin }).on("line", (line) => {
  if (!line.trim()) return;
  if (LOG) appendFileSync(LOG, line + "\n");
  const m = JSON.parse(line);
  if (m.method === undefined && pending.has(m.id)) {
    pending.get(m.id)(m.result);
    pending.delete(m.id);
    return;
  }
  void handle(m);
});
// The real `devin acp` ignores EOF on stdin and exits only on SIGTERM.
if (process.env.FAKE_DEVIN_PID_FILE) writeFileSync(process.env.FAKE_DEVIN_PID_FILE, String(process.pid));
if (!process.env.FAKE_DEVIN_IGNORE_EOF) process.stdin.on("end", () => process.exit(0));
else setInterval(() => {}, 1000);
