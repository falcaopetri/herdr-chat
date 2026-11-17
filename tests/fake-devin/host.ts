// Starts the real host on the devin provider with fake-devin.
import { join } from "node:path";
import { readFileSync, existsSync } from "node:fs";
import { Host, ROOT } from "../host/harness.ts";

export const FAKE_DEVIN = join(ROOT, "tests", "fake-devin", "fake-devin.mjs");

export class DevinHost extends Host {
  get devinLog(): string {
    return join(this.dir, "devin-rpc.jsonl");
  }
  get devinPidFile(): string {
    return join(this.dir, "devin.pid");
  }
  /** What the host sent to fake-devin: requests, notifications and answers. */
  devinMessages(): any[] {
    if (!existsSync(this.devinLog)) return [];
    return readFileSync(this.devinLog, "utf8").split("\n").filter(Boolean).map((l) => JSON.parse(l));
  }
  requests(method?: string): any[] {
    return this.devinMessages().filter((m) => m.method && (!method || m.method === method));
  }
}

export async function devinHost(o: { name: string; session?: string; dir?: string; agent?: string; ignoreEof?: boolean; seed?: string }): Promise<DevinHost> {
  const h = new DevinHost({ name: o.name, provider: "devin", agent: o.agent ?? FAKE_DEVIN, ...(o.dir ? { dir: o.dir } : {}), ...(o.session ? { session: o.session } : {}) });
  h.opts.env = { FAKE_DEVIN_LOG: h.devinLog, FAKE_DEVIN_PID_FILE: h.devinPidFile, ...(o.ignoreEof ? { FAKE_DEVIN_IGNORE_EOF: "1" } : {}), ...(o.seed ? { FAKE_DEVIN_SEED: o.seed } : {}) };
  await h.start();
  return h;
}
