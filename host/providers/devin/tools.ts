// Devin's tools. ACP names a tool call by its `kind` and a title; the name the
// agent itself uses comes in `_meta["cognition.ai/inferenceToolName"]` (exec,
// read, edit…), and that is the name this map knows (map.ts passes it on).
import { num, type ToolMap } from "../../tools.ts";

export const DEVIN_TOOLS: ToolMap = {
  names: {
    exec: "bash",
    shell_command: "bash",
    read: "read",
    edit: "edit",
    apply_patch: "edit",
    notebook_edit: "edit",
    write: "write",
    grep: "search",
    find_file_by_name: "search",
  },
  // An exec's exit code arrives as `_meta.terminal_exit`; map.ts puts it in `result.exitCode`.
  exitCode(r, isError) {
    if ("exitCode" in r) return num(r.exitCode) ?? null;
    return isError ? null : undefined;
  },
};
