import crypto from "node:crypto";
import fs from "node:fs";
import path from "node:path";
import { WebSocket } from "ws";
import { cloudBase } from "../host.js";
import {
  identity,
  keyId,
  LinkCipher,
  MAX_FRAME,
  pairingCode,
  pairingCommitment,
  pairingNonce,
  type HostInfo,
  type LinkIdentity,
} from "../protocol.js";
import type { SecretStore } from "../../warden/secrets.js";
import { digest, FleetError, fleetRoute, HOST_API, HOST_ID } from "./types.js";
import { withFileLock } from "../../soul/lock.js";
import { atomicWrite } from "../../fs-utils.js";

interface Account {
  base: string;
  token: string;
  scope: string;
}
interface PairAttempt {
  host: HostInfo;
  code: string;
  expires: number;
}
type Reply = { status: number; data: Record<string, unknown> };
type Call = { method: string; route: string; body?: Record<string, unknown> };

async function json(base: string, route: string, token: string) {
  const res = await fetch(base + route, {
    headers: { authorization: "Bearer " + token },
    redirect: "error",
    signal: AbortSignal.timeout(8000),
  });
  if (!res.ok)
    throw new FleetError(
      res.status === 403 || res.status === 401 ? 401 : 503,
      "account_or_relay_unavailable",
    );
  return (await res.json()) as Record<string, unknown>;
}

/** A single encrypted request per channel. Only the configured relay receives the
 * account bearer. Uncertain delivery is reconciled by the operation ID on the Mac. */
function exchange(
  account: Account,
  host: HostInfo,
  own: LinkIdentity,
  call?: Call,
): Promise<Reply> {
  const url = new URL("/api/relay/client", account.base);
  url.protocol = url.protocol === "https:" ? "wss:" : "ws:";
  url.searchParams.set("host", host.id);
  return new Promise((resolve, reject) => {
    const salt = pairingNonce(),
      nonce = pairingNonce();
    const cipher = new LinkCipher(own, host.publicKey, salt, "client");
    const ws = new WebSocket(url, {
      headers: { authorization: "Bearer " + account.token },
      maxPayload: MAX_FRAME,
      handshakeTimeout: 8000,
      perMessageDeflate: false,
      followRedirects: false,
    });
    let stage: "welcome" | "pair" | "headers" | "body" = "welcome",
      expectedCode = "",
      status = 0,
      size = 0,
      done = false;
    const chunks: Buffer[] = [];
    const end = (reply?: Reply, err = new FleetError(503, "connection_interrupted")) => {
      if (done) return;
      done = true;
      clearTimeout(timer);
      if (reply) resolve(reply);
      else reject(err);
      ws.terminate();
    };
    const timer = setTimeout(() => end(), 12000);
    ws.on("error", () => end());
    ws.on("close", () => end());
    ws.on("open", () =>
      ws.send(
        JSON.stringify({
          type: "hello",
          v: 2,
          name: "LISA Mac controller",
          publicKey: own.publicKey,
          salt,
          pair: !call,
          ...(!call ? { commit: pairingCommitment(host.publicKey, own.publicKey, nonce) } : {}),
        }),
      ),
    );
    ws.on("message", (data) => {
      if (done) return;
      try {
        const m = cipher.open(JSON.parse(data.toString()));
        if (stage === "welcome") {
          if (m.type !== "welcome" || m.v !== 2 || m.agentHostVersion !== 1)
            throw new FleetError(409, "agent_host_upgrade_required");
          if (!call) {
            if (typeof m.nonce !== "string") throw new FleetError(409, "pairing_unavailable");
            expectedCode = pairingCode(host.publicKey, own.publicKey, nonce, m.nonce);
            stage = "pair";
            ws.send(JSON.stringify(cipher.seal({ type: "pair", nonce, role: "agent-host" })));
          } else {
            if (!m.authorized || m.role !== "agent-host")
              throw new FleetError(403, "workspace_grant_required");
            stage = "headers";
            ws.send(
              JSON.stringify(
                cipher.seal({
                  type: "request",
                  id: crypto.randomUUID(),
                  expiresAt: Date.now() + 60000,
                  challenge: m.challenge,
                  method: call.method,
                  path: call.route,
                  body: call.body ? Buffer.from(JSON.stringify(call.body)).toString("base64") : "",
                }),
              ),
            );
          }
        } else if (stage === "pair") {
          if (m.type !== "paired" || m.code !== expectedCode || m.role !== "agent-host")
            throw Error();
          end({ status: 200, data: { code: expectedCode } });
        } else if (stage === "headers" && m.type === "headers" && Number.isInteger(m.status)) {
          status = Number(m.status);
          stage = "body";
        } else if (stage === "body" && m.type === "chunk" && typeof m.body === "string") {
          const buf = Buffer.from(m.body, "base64");
          size += buf.length;
          if (size > 3 * 1024 * 1024) throw Error();
          chunks.push(buf);
        } else if (stage === "body" && m.type === "end") {
          end({ status, data: JSON.parse(Buffer.concat(chunks).toString("utf8")) });
        } else throw Error();
      } catch (err) {
        end(
          undefined,
          err instanceof FleetError ? err : new FleetError(502, "invalid_agent_host_reply"),
        );
      }
    });
  });
}

export class FleetController {
  private attempts = new Map<string, PairAttempt>();
  constructor(
    private readonly home: string,
    private readonly secrets: SecretStore,
    private readonly config = () => ({
      base: process.env.LISA_MANAGED_BASE || "https://cloud.meetlisa.ai",
      token: process.env.LISA_MANAGED_SESSION || "",
    }),
  ) {}
  private async account(): Promise<Account> {
    const cfg = this.config(),
      base = cloudBase(cfg.base);
    if (!cfg.token) throw new FleetError(401, "sign_in_to_lisa_on_this_mac");
    const me = await json(base, "/api/auth/me", cfg.token);
    if (!me?.signedIn || typeof me.uid !== "string" || !me.uid)
      throw new FleetError(401, "sign_in_to_lisa_on_this_mac");
    return { base, token: cfg.token, scope: digest(base + "|" + me.uid) };
  }
  private async own(a: Account) {
    const name = "fleet/" + a.scope;
    return withFileLock(this.pinFile(a) + ".key.lock", async () => {
      const stored = await this.secrets.get(name);
      if (stored) return JSON.parse(stored) as LinkIdentity;
      const key = identity();
      await this.secrets.set(name, JSON.stringify(key));
      return key;
    });
  }
  private pinFile(a: Account) {
    return path.join(this.home, "fleet", "pins-" + a.scope + ".json");
  }
  private pins(a: Account): HostInfo[] {
    try {
      const value: unknown = JSON.parse(fs.readFileSync(this.pinFile(a), "utf8"));
      if (!Array.isArray(value) || !value.every((h) => this.valid(h))) throw Error();
      return value;
    } catch (err) {
      if ((err as NodeJS.ErrnoException).code === "ENOENT") return [];
      throw new FleetError(503, "host_directory_unreadable");
    }
  }
  private valid(h: HostInfo) {
    return (
      h &&
      typeof h.id === "string" &&
      HOST_ID.test(h.id) &&
      typeof h.name === "string" &&
      h.name.length <= 80 &&
      keyId(h.publicKey) === h.id
    );
  }
  private async available(a: Account): Promise<HostInfo[]> {
    const value = await json(a.base, "/api/relay/macs", a.token);
    if (
      !Array.isArray(value?.hosts) ||
      value.hosts.length > 10 ||
      !value.hosts.every((h: HostInfo) => this.valid(h))
    )
      throw new FleetError(502, "invalid_host_directory");
    return value.hosts;
  }
  async list() {
    const a = await this.account(),
      saved = this.pins(a),
      found = await this.available(a);
    const merged = new Map(saved.map((h) => [h.id, { ...h, online: false, paired: true }]));
    for (const h of found)
      merged.set(h.id, {
        ...h,
        online: true,
        paired: saved.some((p) => p.id === h.id && p.publicKey === h.publicKey),
      });
    return {
      scope: a.scope,
      hosts: [...merged.values()].map(({ id, name, online, paired }) => ({
        id,
        name,
        online,
        paired,
      })),
    };
  }
  async pair(id: string, code?: string) {
    const a = await this.account(),
      k = a.scope + ":" + id;
    for (const [key, p] of this.attempts) if (p.expires < Date.now()) this.attempts.delete(key);
    if (code === undefined) {
      const cached = this.attempts.get(k);
      if (cached) return { code: cached.code };
      const host = (await this.available(a)).find((h) => h.id === id);
      if (!host) throw new FleetError(404, "mac_offline");
      const reply = await exchange(a, host, await this.own(a));
      this.attempts.set(k, {
        host,
        code: String(reply.data.code),
        expires: Date.now() + 5 * 60_000,
      });
      return reply.data;
    }
    const attempt = this.attempts.get(k);
    if (!attempt || attempt.code !== code) throw new FleetError(409, "pairing_expired");
    const reply = await exchange(a, attempt.host, await this.own(a), {
      method: "GET",
      route: HOST_API + "/capabilities",
    });
    if (reply.status !== 200 || reply.data.hostId !== id)
      throw new FleetError(403, "workspace_grant_required");
    await withFileLock(this.pinFile(a) + ".lock", async () => {
      const pins = this.pins(a).filter((p) => p.id !== id);
      if (pins.length >= 32) throw new FleetError(409, "host_directory_full");
      await atomicWrite(this.pinFile(a), JSON.stringify([...pins, attempt.host]), 0o600);
    });
    this.attempts.delete(k);
    return { paired: true };
  }
  async forget(id: string) {
    const a = await this.account();
    await withFileLock(this.pinFile(a) + ".lock", () =>
      atomicWrite(this.pinFile(a), JSON.stringify(this.pins(a).filter((p) => p.id !== id)), 0o600),
    );
    this.attempts.delete(a.scope + ":" + id);
  }
  async request(scope: string, id: string, call: Call) {
    const a = await this.account();
    if (scope !== a.scope || !fleetRoute(call.method, call.route))
      throw new FleetError(403, "target_changed");
    const host = this.pins(a).find((h) => h.id === id);
    if (!host) throw new FleetError(403, "mac_not_paired");
    return exchange(a, host, await this.own(a), call);
  }
}
