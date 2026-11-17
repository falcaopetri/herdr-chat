// Devin runs through the real host (fake-devin over ACP): a turn, a tool, an approval, abort, follow-up, resume.
import { test } from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { idle } from "./harness.ts";
import { devinHost } from "../fake-devin/host.ts";

const answered = (text: RegExp) => (x: any) => idle(x) && x.items.some((i: any) => i.kind === "assistant" && text.test(i.text) && !i.streaming);

test("devin: a prompt streams a reply and the chat goes idle", async () => {
  const h = await devinHost({ name: "dv-basic" });
  try {
    const c = h.client;
    await c.waitFor(idle, 10_000);
    assert.equal(c.state.provider, "devin");
    await c.req("send", { text: "hello" });
    await c.waitFor(answered(/Echo: hello/), 5000);
    assert.ok(c.items.some((i: any) => i.kind === "user" && /hello/.test(i.text)));
  } finally {
    await h.stop();
  }
});

test("devin: a command runs as a tool card with its output", async () => {
  const h = await devinHost({ name: "dv-tool" });
  try {
    const c = h.client;
    await c.waitFor(idle, 10_000);
    await c.req("send", { text: "run echo out" });
    await c.waitFor(answered(/Done\./), 5000);
    const tool = c.items.find((i: any) => i.kind === "tool");
    assert.equal(tool.title, "$ echo out");
    assert.equal(tool.status, "done");
    assert.match(tool.output, /out/);
  } finally {
    await h.stop();
  }
});

test("devin: an approval is asked, and Allow / Deny reach the agent", async () => {
  const h = await devinHost({ name: "dv-ask" });
  try {
    const c = h.client;
    await c.waitFor(idle, 10_000);
    const asked = (x: any) => x.state.dialog?.method === "permission";
    await c.req("send", { text: "ask echo out" });
    await c.waitFor(asked, 5000, "first approval");
    let d = c.state.dialog;
    assert.equal(d.tool.title, "$ echo out");
    assert.deepEqual(d.choices.map((x: any) => x.id), ["allow_once", "allow_always", "reject_once"]);
    await c.req("dialog_answer", { dialog: d.id, choice: "allow_once" });
    await c.waitFor(answered(/Done\./), 5000);
    await c.req("send", { text: "ask echo no" });
    await c.waitFor((x: any) => asked(x) && x.state.dialog.id !== d.id, 5000, "second approval");
    d = c.state.dialog;
    await c.req("dialog_answer", { dialog: d.id, choice: "reject_once" });
    await c.waitFor(answered(/Denied\./), 5000);
  } finally {
    await h.stop();
  }
});

test("devin: Esc cancels a run and restores the queued follow-up", async () => {
  const h = await devinHost({ name: "dv-abort" });
  try {
    const c = h.client;
    await c.waitFor(idle, 10_000);
    await c.req("send", { text: "slow please" });
    await c.waitFor((x: any) => x.state.phase !== "idle", 3000, "working");
    assert.equal((await c.req("send", { text: "then this", mode: "followUp" })).disposition, "queued");
    const r = await c.req("abort");
    assert.deepEqual(r.restored, ["then this"]);
    await c.waitFor(idle, 5000, "idle after abort");
    assert.equal(h.requests("session/cancel").length, 1);
    assert.equal(h.requests("session/prompt").length, 1);
  } finally {
    await h.stop();
  }
});

test("devin: model and mode come from the agent's config options, and /resume lists sessions", async () => {
  const h = await devinHost({ name: "dv-settings" });
  try {
    const c = h.client;
    await c.waitFor(idle, 10_000);
    assert.equal(c.state.permissionMode, "accept-edits");
    assert.deepEqual(c.state.capabilities.permissionModes.map((m: any) => m.id), ["accept-edits", "ask", "plan", "bypass"]);
    await c.req("send", { text: "hello there" });
    await c.waitFor(answered(/Echo: hello there/), 5000);
    await c.req("set_permission_mode", { mode: "ask" });
    await c.waitFor((x: any) => x.state.permissionMode === "ask", 3000, "mode ask");
    assert.equal(h.requests("session/set_mode").length, 1);
    const r = await c.req("sessions", { scope: "cwd" });
    assert.ok(JSON.stringify(r).includes("hello there"), "the session is listed by its title");
  } finally {
    await h.stop();
  }
});

test("devin: stopping the host ends a `devin acp` that ignores EOF (it would hold the session for the next host)", async () => {
  const h = await devinHost({ name: "dv-stop", ignoreEof: true });
  let pid = 0;
  try {
    await h.client.waitFor(idle, 10_000);
    pid = Number(readFileSync(h.devinPidFile, "utf8"));
    assert.ok(pid > 0);
  } finally {
    await h.stop();
  }
  const alive = () => { try { process.kill(pid, 0); return true; } catch { return false; } };
  for (const t0 = Date.now(); alive() && Date.now() - t0 < 3000;) await new Promise((r) => setTimeout(r, 50));
  assert.equal(alive(), false, "the agent process is gone");
});

test("devin: resuming a session handed over as a path (the core resolves it against the folder) loads its bare id and shows the history", async () => {
  const h = await devinHost({ name: "dv-resume", seed: "popular-puck", session: "/some/folder/popular-puck" });
  try {
    const c = h.client;
    await c.waitFor(idle, 10_000);
    assert.equal(h.requests("session/load")[0].params.sessionId, "popular-puck");
    assert.equal(h.requests("session/new").length, 0, "no new session was started");
    await c.waitFor((x: any) => x.items.some((i: any) => i.kind === "assistant" && /first answer/.test(i.text)), 5000, "history shown");
    assert.ok(c.items.some((i: any) => i.kind === "user" && /first question/.test(i.text)));
    await c.req("send", { text: "and now?" });
    await c.waitFor(answered(/Echo: and now\?/), 5000);
  } finally {
    await h.stop();
  }
});
