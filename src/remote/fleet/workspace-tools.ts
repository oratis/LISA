import fs from "node:fs";
import path from "node:path";
import { digest, FleetError, requiredText } from "./types.js";
import { restoreState, restoreFile } from "./restore.js";

const schemas: Record<string, Record<string, unknown>> = {
  List: {},
  Read: {},
  Edit: { old_string: { type: "string" }, new_string: { type: "string" } },
  Write: { content: { type: "string" } },
};
export const workspaceTools = Object.entries(schemas).map(([name, properties]) => ({
  type: "function",
  deferLoading: false,
  name: "fleet_" + name.toLowerCase(),
  description:
    name +
    " within the approved project. Requires fresh owner approval for each call. Dot paths, symlinks, hardlinks and special files are forbidden; parent directories must already exist. Read/Edit are UTF-8 text only, at most 64 KiB. List returns one directory, at most 500 entries.",
  inputSchema: {
    type: "object",
    additionalProperties: false,
    required: ["file_path", ...Object.keys(properties)],
    properties: { file_path: { type: "string" }, ...properties },
  },
}));

function selection(root: string, value: unknown, directory: boolean) {
  if (
    typeof value !== "string" ||
    !value ||
    value.includes("\0") ||
    value.includes("\\") ||
    path.isAbsolute(value)
  )
    throw new FleetError(403, "workspace_path_denied");
  if (directory && value === ".") return ".";
  const parts = value.split("/");
  if (parts.some((p) => !p || p.startsWith(".")))
    throw new FleetError(403, "workspace_path_denied");
  let current = root;
  for (const part of ["", ...parts.slice(0, directory ? undefined : -1)]) {
    current = path.join(current, part);
    const st = fs.lstatSync(current);
    if (!st.isDirectory() || st.isSymbolicLink())
      throw new FleetError(403, "workspace_path_denied");
  }
  return parts.join("/");
}
function list(root: string, name: string) {
  const directory = path.join(root, name),
    before = fs.lstatSync(directory, { bigint: true });
  if (!before.isDirectory() || before.isSymbolicLink())
    throw new FleetError(403, "workspace_path_denied");
  const names = fs.readdirSync(directory, { encoding: "buffer" });
  if (names.length > 500) throw new FleetError(413, "directory_limit");
  const entries = names
    .flatMap((raw) => {
      const entry = raw.toString();
      if (!Buffer.from(entry).equals(raw) || entry.startsWith(".")) return [];
      const st = fs.lstatSync(path.join(directory, entry), { bigint: true });
      if (st.isSymbolicLink() || (!st.isDirectory() && (!st.isFile() || st.nlink !== 1n)))
        return [];
      return [
        { name: entry, kind: st.isDirectory() ? "directory" : "file", bytes: Number(st.size) },
      ];
    })
    .sort((a, b) => a.name.localeCompare(b.name));
  const after = fs.lstatSync(directory, { bigint: true });
  const identity = (s: fs.BigIntStats) => [s.dev, s.ino, s.mtimeNs, s.ctimeNs].join(":");
  if (identity(before) !== identity(after)) throw new FleetError(409, "workspace_changed");
  return {
    text: JSON.stringify(entries),
    fingerprint: digest(identity(after) + JSON.stringify(entries)),
  };
}

/** Prepare a request without disclosing content. Approval consumes this exact
 * snapshot once; the adapter rejects concurrent calls and owns the expiry. */
export function prepareWorkspaceTool(root: string, tool: string, args: unknown) {
  const name = { fleet_list: "List", fleet_read: "Read", fleet_edit: "Edit", fleet_write: "Write" }[
    tool
  ];
  if (
    !name ||
    !args ||
    typeof args !== "object" ||
    Array.isArray(args) ||
    Buffer.byteLength(JSON.stringify(args)) > 32 * 1024
  )
    throw new FleetError(403, "workspace_tool_denied");
  const input = structuredClone(args) as Record<string, unknown>;
  const allowed = ["file_path", ...Object.keys(schemas[name]!)];
  if (
    Object.keys(input).some((key) => !allowed.includes(key)) ||
    allowed.some((key) => typeof input[key] !== "string")
  )
    throw new FleetError(403, "workspace_tool_denied");
  const initialRoot = fs.lstatSync(root, { bigint: true });
  if (!initialRoot.isDirectory() || initialRoot.isSymbolicLink())
    throw new FleetError(403, "workspace_path_denied");
  const selected = selection(root, input.file_path, name === "List");
  const current = name === "List" ? list(root, selected) : restoreState(root, selected);
  let used = false;
  const verify = () => {
    if (used) throw new FleetError(409, "tool_already_consumed");
    used = true;
    const st = fs.lstatSync(root, { bigint: true });
    if (st.dev !== initialRoot.dev || st.ino !== initialRoot.ino || st.isSymbolicLink())
      throw new FleetError(409, "workspace_changed");
    selection(root, selected, name === "List");
    const now = name === "List" ? list(root, selected) : restoreState(root, selected);
    if (now.fingerprint !== current.fingerprint) throw new FleetError(409, "workspace_changed");
  };
  if (name === "List")
    return {
      name,
      input,
      execute() {
        verify();
        return (current as ReturnType<typeof list>).text;
      },
    };
  const file = current as ReturnType<typeof restoreState>;
  if (
    name !== "Write" &&
    (!file.exists ||
      file.content.length > 64 * 1024 ||
      file.content.includes(0) ||
      !Buffer.from(file.content.toString()).equals(file.content))
  )
    throw new FleetError(413, "text_file_limit");
  let content = file.content;
  if (name === "Write") content = Buffer.from(String(input.content));
  if (name === "Edit") {
    const old = requiredText(input.old_string, 32000),
      text = file.content.toString();
    const index = text.indexOf(old);
    if (index < 0 || text.indexOf(old, index + old.length) >= 0)
      throw new FleetError(409, "edit_match_required");
    content = Buffer.from(
      text.slice(0, index) + String(input.new_string) + text.slice(index + old.length),
    );
  }
  return {
    name,
    input: {
      ...input,
      current_sha256: digest(file.content),
      current_bytes: file.content.length,
      exists: file.exists,
    },
    execute() {
      verify();
      if (name === "Read") return file.content.toString();
      restoreFile(
        root,
        { path: selected, exists: true, content, mode: file.exists ? file.mode : 0o644 },
        file.fingerprint,
      );
      return JSON.stringify({ written: true, bytes: content.length, sha256: digest(content) });
    },
  };
}
