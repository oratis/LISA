import { randomUUID } from "node:crypto";
import path from "node:path";
import { EncryptedFileSecretStore, localKeyFile } from "../../warden/secrets-file.js";
import { ConnectorError, type CredentialAccess, type ReadonlyDriver } from "../types.js";
import type { Resource } from "../workspace/data.js";

interface ImportedGame {
  title: string;
  source?: string;
  platform?: string;
  version?: string;
  sourceId?: string;
  playtimeSeconds?: number;
  exportedAt?: string;
}
interface Snapshot {
  id: string;
  importedAt: string;
  games: ImportedGame[];
}
const snapshotId = /^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/;
const textLimits = { title: 200, source: 80, platform: 80, version: 64 } as const;
const keys = new Set([...Object.keys(textLimits), "sourceId", "playtimeSeconds", "exportedAt"]);
const validText = (v: unknown, max: number): v is string =>
  typeof v === "string" &&
  v.length > 0 &&
  v.length <= max &&
  v.trim() === v &&
  !/[\p{Cc}\ud800-\udfff\u202a-\u202e\u2066-\u2069]/u.test(v);
const isRecord = (v: unknown): v is Record<string, unknown> =>
  !!v && typeof v === "object" && !Array.isArray(v);
const isoTime = (v: unknown): v is string =>
  typeof v === "string" &&
  /^\d{4}-\d\d-\d\dT\d\d:\d\d:\d\d\.\d{3}Z$/.test(v) &&
  Number.isFinite(Date.parse(v)) &&
  new Date(v).toISOString() === v;

function validGame(v: unknown): v is ImportedGame {
  if (
    !isRecord(v) ||
    !validText(v.title, textLimits.title) ||
    !Object.keys(v).every((k) => keys.has(k))
  )
    return false;
  for (const [key, limit] of Object.entries(textLimits)) {
    if (v[key] !== undefined && !validText(v[key], limit)) return false;
  }
  return (
    (v.sourceId === undefined ||
      (typeof v.sourceId === "string" && /^[a-zA-Z0-9._-]{1,128}$/.test(v.sourceId))) &&
    (v.playtimeSeconds === undefined ||
      (typeof v.playtimeSeconds === "number" &&
        Number.isSafeInteger(v.playtimeSeconds) &&
        v.playtimeSeconds >= 0)) &&
    (v.exportedAt === undefined || isoTime(v.exportedAt))
  );
}
function validGames(v: unknown): v is ImportedGame[] {
  return Array.isArray(v) && v.length >= 1 && v.length <= 30 && v.every(validGame);
}
function parseJson(value: string | undefined): unknown {
  if (value && Buffer.byteLength(value) <= 128 * 1024) {
    try {
      return JSON.parse(value);
    } catch {
      /* Only return a fixed, data-free error. */
    }
  }
  throw new ConnectorError("game_import_invalid");
}
function snapshot(token: string): Snapshot {
  const s = parseJson(token);
  if (
    !isRecord(s) ||
    typeof s.id !== "string" ||
    !snapshotId.test(s.id) ||
    !isoTime(s.importedAt) ||
    !validGames(s.games)
  )
    throw new ConnectorError("game_import_required");
  return { id: s.id, importedAt: s.importedAt, games: s.games };
}
const resourceId = (s: Snapshot, index: number) => s.id + ":" + (index + 1);
function gameChoice(s: Snapshot, index: number): Resource {
  const game = s.games[index]!;
  const label = [game.title, game.source, game.platform, game.version, game.sourceId]
    .filter(Boolean)
    .join(" · ");
  return { id: resourceId(s, index), name: `#${index + 1} · ${label}` };
}

// Imported rows are user data and can exceed the per-item Keychain CLI limit.
// The connector lifecycle removes this encrypted snapshot on cancellation or disconnect.
export function openGameImportStore(home: string) {
  const dir = path.join(home, "warden", "game-library");
  return new EncryptedFileSecretStore({
    backend: "file",
    file: path.join(dir, "snapshots.enc.json"),
    keys: localKeyFile(path.join(dir, "snapshot.key")),
    scope: "local:game-library",
  });
}

export class GameImportDriver implements ReadonlyDriver<Resource, Resource> {
  readonly id = "game-library";
  readonly authModes = ["import"];
  readonly reauthorizationCode = "game_import_required";
  readonly tool = {
    name: "game_library_import_read",
    description:
      "Read selected games from the user's local CSV snapshot. Entries document a user import. Report absent data as unknown; keep different sources and editions separate.",
    inputSchema: {
      type: "object" as const,
      properties: {
        operation: { type: "string", enum: ["list", "read"] },
        resourceId: { type: "string" },
      },
      additionalProperties: false,
      required: ["operation"],
    },
  };
  validAccount = (v: unknown): v is Resource =>
    isRecord(v) && typeof v.id === "string" && snapshotId.test(v.id) && v.name === "CSV";
  accountId = (a: Resource) => a.id;
  validResourceName = (v: unknown): v is string => {
    if (typeof v !== "string") return false;
    const [id, index, extra] = v.split(":");
    return (
      extra === undefined && snapshotId.test(id ?? "") && /^(?:[1-9]|[12]\d|30)$/.test(index ?? "")
    );
  };
  validResource = (v: unknown): v is Resource =>
    isRecord(v) && this.validResourceName(v.id) && validText(v.name, 600);

  async authorize(
    mode: string,
    signal: AbortSignal,
    _progress: (v: { userCode?: string; authorizationUrl?: string }) => void,
    selection?: string,
  ) {
    signal.throwIfAborted();
    if (mode !== "import" || !selection) throw new ConnectorError("game_import_required");
    const games = parseJson(selection);
    if (!validGames(games)) throw new ConnectorError("game_import_invalid");
    const s: Snapshot = { id: randomUUID(), importedAt: new Date().toISOString(), games };
    return { token: JSON.stringify(s), account: { id: s.id, name: "CSV" } };
  }
  private use<T>(credentials: CredentialAccess, signal: AbortSignal, read: (s: Snapshot) => T) {
    return credentials.use(async (token) => {
      signal.throwIfAborted();
      return read(snapshot(token));
    });
  }
  account(c: CredentialAccess, signal: AbortSignal) {
    return this.use(c, signal, (s) => ({ id: s.id, name: "CSV" }));
  }
  resources(c: CredentialAccess, page: number, signal: AbortSignal) {
    if (!Number.isInteger(page) || page < 1 || page > 10) throw new ConnectorError("invalid_page");
    return this.use(c, signal, (s) => (page === 1 ? s.games.map((_, i) => gameChoice(s, i)) : []));
  }
  private index(s: Snapshot, id: string): number {
    if (this.validResourceName(id) && id.startsWith(s.id + ":")) {
      const i = Number(id.slice(s.id.length + 1)) - 1;
      if (s.games[i]) return i;
    }
    throw new ConnectorError("game_import_scope");
  }
  resource(c: CredentialAccess, id: string, signal: AbortSignal) {
    return this.use(c, signal, (s) => gameChoice(s, this.index(s, id)));
  }
  read(
    c: CredentialAccess,
    account: Resource,
    resources: Resource[],
    input: unknown,
    signal: AbortSignal,
  ) {
    if (
      !isRecord(input) ||
      !Object.keys(input).every((k) => k === "operation" || k === "resourceId") ||
      !(input.operation === "list"
        ? input.resourceId === undefined
        : input.operation === "read" && this.validResourceName(input.resourceId))
    )
      throw new ConnectorError("game_import_scope");
    return this.use(c, signal, (s) => {
      if (!this.validAccount(account) || account.id !== s.id)
        throw new ConnectorError("connector_account_changed");
      const chosen =
        input.operation === "list" ? resources : resources.filter((r) => r.id === input.resourceId);
      if (!chosen.length) throw new ConnectorError("game_import_scope");
      const games = chosen.map((r) => {
        const index = this.index(s, r.id);
        return { resourceId: r.id, ...s.games[index] };
      });
      return { evidence: "user_imported_csv", importedAt: s.importedAt, games };
    });
  }
}
