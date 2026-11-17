// Continue as chat for Devin: not supported yet. Devin's TUI keeps no file a
// process can be matched to (sessions live in a database keyed by id), so the
// chat can't tell which session a running TUI has open.
import type { TuiQuery, TuiSession } from "../tui.ts";

export function devinTuiSession(_q: TuiQuery): TuiSession {
  throw new Error("Continue as chat isn't supported for Devin yet: start a chat with Devin instead");
}
