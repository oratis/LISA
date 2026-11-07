import fs from "node:fs/promises";
import http from "node:http";
import { randomBytes, createHash, timingSafeEqual } from "node:crypto";
import type { AddressInfo } from "node:net";
import { ConnectorError } from "./types.js";
import type { GoogleHttp } from "./google-http.js";

export interface GoogleClient {
  clientId: string;
  clientSecret?: string;
}
export interface GoogleCredential extends GoogleClient {
  accessToken: string;
  refreshToken: string;
  expiry: number;
  scopes: string[];
  allowedScopes: string[];
  /** Only present for the desktop Picker flow; never inferred from a Drive listing. */
  pickedFileIds?: string[];
}
export const GOOGLE_SCOPES = {
  identity: ["openid", "https://www.googleapis.com/auth/userinfo.email"],
  gmail: ["https://www.googleapis.com/auth/gmail.readonly"],
  driveFile: ["https://www.googleapis.com/auth/drive.file"],
  events: [
    "https://www.googleapis.com/auth/calendar.events.readonly",
    "https://www.googleapis.com/auth/calendar.calendarlist.readonly",
    "https://www.googleapis.com/auth/calendar.events.freebusy",
  ],
  freebusy: ["https://www.googleapis.com/auth/calendar.freebusy"],
} as const;

export async function googleClient(): Promise<GoogleClient> {
  const file = process.env.LISA_GOOGLE_CLIENT_FILE;
  let client: GoogleClient;
  if (file) {
    try {
      if ((await fs.stat(file)).size > 32_000) throw new Error();
      const data = JSON.parse(await fs.readFile(file, "utf8")) as {
        installed?: { client_id?: string; client_secret?: string };
      };
      if (!data.installed) throw new Error();
      client = {
        clientId: data.installed.client_id ?? "",
        clientSecret: data.installed.client_secret,
      };
    } catch {
      throw new ConnectorError("google_desktop_client_required");
    }
  } else
    client = {
      clientId: process.env.LISA_GOOGLE_CLIENT_ID ?? "",
      clientSecret: process.env.LISA_GOOGLE_CLIENT_SECRET,
    };
  if (!/^[A-Za-z0-9._-]+\.apps\.googleusercontent\.com$/.test(client.clientId))
    throw new ConnectorError("google_client_not_configured");
  return client;
}

export function parseGoogleCredential(value: string): GoogleCredential {
  try {
    const c = JSON.parse(value) as GoogleCredential;
    if (
      !c ||
      !c.clientId ||
      !c.accessToken ||
      !c.refreshToken ||
      !Number.isFinite(c.expiry) ||
      !Array.isArray(c.scopes) ||
      c.scopes.some((s) => typeof s !== "string") ||
      !Array.isArray(c.allowedScopes) ||
      c.allowedScopes.some((s) => typeof s !== "string" || !c.scopes.includes(s))
    )
      throw new Error();
    return c;
  } catch {
    throw new ConnectorError("google_reauthorization_required");
  }
}

export function tokenResponse(
  data: Record<string, unknown>,
  client: GoogleClient,
  scopes: readonly string[],
  previous?: GoogleCredential,
): GoogleCredential {
  const actual = typeof data.scope === "string" ? data.scope.split(" ") : previous?.scopes;
  if (!actual || scopes.some((s) => !actual.includes(s)))
    throw new ConnectorError("google_scope_required");
  const refreshToken =
    typeof data.refresh_token === "string" ? data.refresh_token : previous?.refreshToken;
  if (
    typeof data.access_token !== "string" ||
    !data.access_token ||
    !refreshToken ||
    typeof data.expires_in !== "number" ||
    data.expires_in <= 0 ||
    data.expires_in > 86400
  )
    throw new ConnectorError("google_invalid_response");
  return {
    ...client,
    accessToken: data.access_token,
    refreshToken,
    expiry: Date.now() + data.expires_in * 1000,
    scopes: actual,
    allowedScopes: previous?.allowedScopes ?? [...scopes],
  };
}

export async function refreshGoogle(
  c: GoogleCredential,
  httpRequest: GoogleHttp,
  signal: AbortSignal,
): Promise<GoogleCredential> {
  const form = new URLSearchParams({
    client_id: c.clientId,
    refresh_token: c.refreshToken,
    grant_type: "refresh_token",
  });
  if (c.clientSecret) form.set("client_secret", c.clientSecret);
  return tokenResponse(
    await httpRequest("https://oauth2.googleapis.com/token", signal, { form }),
    c,
    c.allowedScopes,
    c,
  );
}

/** Native installed-app authorization. PKCE/state stay in memory, never in the card. */
export async function authorizeGoogle(
  client: GoogleClient,
  scopes: readonly string[],
  signal: AbortSignal,
  progress: (value: { authorizationUrl: string }) => void,
  httpRequest: GoogleHttp,
  options: { drivePicker?: boolean } = {},
): Promise<GoogleCredential> {
  signal.throwIfAborted();
  if (options.drivePicker && (scopes.length !== 1 || scopes[0] !== GOOGLE_SCOPES.driveFile[0]))
    throw new ConnectorError("google_scope_required");
  let pickedFileIds: string[] | undefined;
  const state = randomBytes(32).toString("base64url"),
    verifier = randomBytes(48).toString("base64url");
  let resolveCode!: (code: string) => void, rejectCode!: (error: Error) => void;
  const codeResult = new Promise<string>((resolve, reject) => {
    resolveCode = resolve;
    rejectCode = reject;
  });
  void codeResult.catch(() => {});
  let consumed = false;
  const server = http.createServer((req, res) => {
    res.setHeader("Cache-Control", "no-store");
    res.setHeader("Content-Type", "text/plain; charset=utf-8");
    res.setHeader("Referrer-Policy", "no-referrer");
    res.setHeader("Content-Security-Policy", "default-src 'none'; frame-ancestors 'none'");
    const port = (server.address() as AddressInfo).port;
    let url: URL;
    try {
      url = new URL(req.url ?? "/", "http://127.0.0.1");
    } catch {
      res.writeHead(400);
      res.end("Invalid authorization callback.");
      return;
    }
    const received = url.searchParams.get("state") ?? "";
    if (
      req.method !== "GET" ||
      req.headers.host !== `127.0.0.1:${port}` ||
      url.pathname !== "/oauth/google" ||
      consumed ||
      !/^[A-Za-z0-9_-]{43}$/.test(received) ||
      !timingSafeEqual(Buffer.from(received), Buffer.from(state))
    ) {
      res.writeHead(400);
      res.end("Invalid or expired authorization callback.");
      return;
    }
    consumed = true;
    if (url.searchParams.has("error")) {
      res.end("Authorization cancelled. Return to LISA.");
      rejectCode(new ConnectorError("authorization_cancelled"));
      return;
    }
    const code = url.searchParams.get("code");
    if (!code || code.length > 4096) {
      res.writeHead(400);
      res.end("Invalid authorization response.");
      rejectCode(new ConnectorError("google_authorization_failed"));
      return;
    }
    if (options.drivePicker) {
      const ids = (url.searchParams.get("picked_file_ids") ?? "").split(",");
      if (
        !ids.length ||
        ids.length > 30 ||
        ids.some((id) => !/^[A-Za-z0-9_-]{10,200}$/.test(id)) ||
        new Set(ids).size !== ids.length
      ) {
        res.writeHead(400);
        res.end("No supported files were selected. Return to LISA and choose files again.");
        rejectCode(new ConnectorError("drive_selection_required"));
        return;
      }
      pickedFileIds = ids;
    }
    res.end("Google sign-in received. Return to LISA to select the read-only access scope.");
    resolveCode(code);
  });
  const cancel = () => rejectCode(new ConnectorError("authorization_cancelled"));
  const timer = setTimeout(
    () => rejectCode(new ConnectorError("authorization_expired")),
    10 * 60_000,
  );
  signal.addEventListener("abort", cancel, { once: true });
  try {
    await new Promise<void>((resolve, reject) => {
      server.once("error", reject);
      server.listen(0, "127.0.0.1", resolve);
    });
    signal.throwIfAborted();
    const redirect = `http://127.0.0.1:${(server.address() as AddressInfo).port}/oauth/google`;
    const params = new URLSearchParams({
      client_id: client.clientId,
      redirect_uri: redirect,
      response_type: "code",
      scope: scopes.join(" "),
      state,
      code_challenge: createHash("sha256").update(verifier).digest("base64url"),
      code_challenge_method: "S256",
      access_type: "offline",
      prompt: "consent select_account",
      include_granted_scopes: "false",
    });
    if (options.drivePicker) {
      params.set("trigger_onepick", "true");
      params.set("allow_multiple", "true");
      params.set(
        "mimetypes",
        "application/vnd.google-apps.document,application/vnd.google-apps.spreadsheet,application/vnd.google-apps.presentation,text/plain,text/markdown,text/csv,text/tab-separated-values,application/json",
      );
    }
    progress({ authorizationUrl: `https://accounts.google.com/o/oauth2/v2/auth?${params}` });
    const code = await codeResult;
    signal.throwIfAborted();
    const form = new URLSearchParams({
      client_id: client.clientId,
      code,
      redirect_uri: redirect,
      code_verifier: verifier,
      grant_type: "authorization_code",
    });
    if (client.clientSecret) form.set("client_secret", client.clientSecret);
    const credential = tokenResponse(
      await httpRequest("https://oauth2.googleapis.com/token", signal, { form }),
      client,
      scopes,
    );
    return pickedFileIds ? { ...credential, pickedFileIds } : credential;
  } finally {
    clearTimeout(timer);
    signal.removeEventListener("abort", cancel);
    server.closeAllConnections();
    if (server.listening) await new Promise<void>((resolve) => server.close(() => resolve()));
  }
}
