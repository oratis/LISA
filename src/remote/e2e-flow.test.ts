/**
 * Pocket → cloud relay → Mac, end to end, with every hop real: the hosted edition with its
 * relay broker (a child process, tests/fixtures/remote/cloud.ts, because the edition is
 * process-wide), the Mac backend in this process with a scripted model, and a Node phone
 * speaking Pocket's protocol (tests/fixtures/remote/phone.ts). One connected scenario:
 * discovery, pairing v2, REST/SSE/cancel through the tunnel, revocation, and the LAN route
 * with the relay stopped. Loopback only and no sleeps: state in the other process is polled
 * until a deadline, and every other wait is an awaited event with its own deadline.
 */
import { test } from "node:test";
import assert from "node:assert/strict";
import { fork } from "node:child_process";
import crypto from "node:crypto";
import fs from "node:fs";
import type http from "node:http";
import os from "node:os";
import path from "node:path";
import type { AddressInfo } from "node:net";
import type { Provider } from "../providers/types.js";
import type { StoredMessage } from "../types.js";
import { LISA_API_VERSION } from "../web/api-contract.js";
import { keyId } from "./protocol.js";
import {
  LinkClosedError,
  NotAllowedError,
  Phone,
  STEP_MS,
  type Frame,
  type MacTarget,
} from "../../tests/fixtures/remote/phone.js";

const root = fs.mkdtempSync(path.join(os.tmpdir(), "lisa-remote-e2e-"));
const macHome = path.join(root, "mac");
const cloudHome = path.join(root, "cloud");
fs.mkdirSync(macHome);
fs.mkdirSync(cloudHome);
process.env.LISA_HOME = macHome;
process.env.CLAUDE_HOME = path.join(macHome, "claude");
process.env.CODEX_HOME = path.join(macHome, "codex");
process.env.LISA_SOUL_GIT = "0";
process.env.LISA_MAIL_POLL_MINUTES = "0";
for (const name of [
  "LISA_EDITION",
  "LISA_RELAY_ENABLED",
  "LISA_WEB_TOKEN",
  "LISA_MANAGED_BASE",
  "LISA_MANAGED_SESSION",
  "LISA_FIRESTORE",
  "K_SERVICE",
  "LISA_MODEL_FALLBACK",
])
  delete process.env[name];

function within<T>(promise: Promise<T>, ms: number, what: string): Promise<T> {
  let timer: NodeJS.Timeout | undefined;
  const expired = new Promise<never>((_, reject) => {
    timer = setTimeout(() => reject(new Error(`timed out after ${ms} ms: ${what}`)), ms);
  });
  return Promise.race([promise, expired]).finally(() => clearTimeout(timer));
}
/** For state in another process, which has no event to await here. */
async function eventually<T>(read: () => Promise<T>, check: (value: T) => boolean): Promise<T> {
  const deadline = Date.now() + 10_000;
  for (;;) {
    const value = await read();
    if (check(value)) return value;
    if (Date.now() > deadline) throw new Error(`condition timed out: ${JSON.stringify(value)}`);
    await new Promise((resolve) => setTimeout(resolve, 20));
  }
}

// The Mac's model: answers at once, except HOLD, which streams a little and then waits
// until the Mac aborts the turn.
const REPLY = "Hello from the fixture model.";
const HOLD = "Keep talking until I stop you.";
const prompts: string[] = [];
let heldTurnAborted!: () => void;
const heldAborted = new Promise<void>((resolve) => (heldTurnAborted = resolve));
function userText(messages: StoredMessage[]): string {
  const user = messages.findLast((m) => m.role === "user");
  if (!user) return "";
  if (typeof user.content === "string") return user.content;
  return user.content.map((block) => (block.type === "text" ? block.text : "")).join("");
}
const provider: Provider = {
  name: "fixture",
  async runTurn({ messages, handlers, signal }) {
    const prompt = userText(messages);
    prompts.push(prompt);
    if (prompt.includes(HOLD)) {
      handlers?.onTextDelta?.("Let me think");
      await new Promise<never>((_, reject) => {
        if (!signal) return reject(new Error("the turn has no abort signal"));
        const stop = () => {
          heldTurnAborted();
          reject(signal.reason ?? new Error("aborted"));
        };
        if (signal.aborted) stop();
        else signal.addEventListener("abort", stop, { once: true });
      });
    }
    handlers?.onTextDelta?.(REPLY);
    return {
      content: [{ type: "text", text: REPLY, citations: null }],
      stopReason: "end_turn",
      usage: { inputTokens: 10, outputTokens: 10, cacheReadTokens: 0, cacheWriteTokens: 0 },
    };
  },
};

type Account = { uid: string; token: string };
/** The hosted edition in its own process; reports its port and two accounts' sessions. */
function launchCloud() {
  const child = fork(new URL("../../tests/fixtures/remote/cloud.ts", import.meta.url), [], {
    execArgv: ["--import", "tsx"],
    stdio: ["ignore", "pipe", "pipe", "ipc"],
    env: {
      PATH: process.env.PATH,
      TMPDIR: os.tmpdir(),
      LISA_HOME: cloudHome,
      CLAUDE_HOME: path.join(cloudHome, "claude"),
      CODEX_HOME: path.join(cloudHome, "codex"),
      LISA_EDITION: "cloud",
      LISA_RELAY_ENABLED: "1",
      LISA_WEB_TOKEN: "operator-demo-token",
      LISA_PUBLIC_ORIGIN: "https://cloud.example",
      LISA_SOUL_GIT: "0",
      LISA_MAIL_POLL_MINUTES: "0",
    },
  });
  let output = "";
  const keep = (data: Buffer) => {
    output = (output + data.toString()).slice(-8_000);
  };
  child.stdout?.on("data", keep);
  child.stderr?.on("data", keep);
  const exited = new Promise<void>((resolve) => child.once("exit", () => resolve()));
  const ready = new Promise<{ base: string; accounts: Record<"alice" | "bob", Account> }>(
    (resolve, reject) => {
      child.once(
        "message",
        (message: { port: number; accounts: Record<"alice" | "bob", Account> }) =>
          resolve({ base: `http://127.0.0.1:${message.port}`, accounts: message.accounts }),
      );
      void exited.then(() => reject(new Error(`cloud server exited early:\n${output}`)));
    },
  );
  return {
    ready: within(ready, 30_000, "cloud server start"),
    /** The relay goes away: the process dies with every socket it held. */
    stop: async () => {
      if (child.exitCode === null && child.signalCode === null) child.kill("SIGKILL");
      await within(exited, STEP_MS, "cloud server exit");
    },
  };
}

interface RemoteStatus {
  enabled: boolean;
  online: boolean;
  hostId: string | null;
  activeConnections: number;
  pending: Array<{ id: string; code: string; secure: boolean; waiting: boolean }>;
  devices: Array<{ id: string; secure: boolean }>;
}

test(
  "Pocket → cloud relay → Mac: discovery, pairing v2, tunnelled REST/SSE/cancel, revocation, LAN without the relay",
  { timeout: 60_000 },
  async () => {
    const cloud = launchCloud();
    void cloud.ready.catch(() => {});
    let mac: http.Server | undefined;
    const phones: Phone[] = [];
    try {
      const { startWebServer } = await import("../web/server.js");
      mac = await startWebServer({
        port: 0,
        host: "127.0.0.1",
        tools: [],
        model: "fixture",
        thinking: false,
        reflect: false,
        idleMinutes: 0,
        hooks: [],
        provider,
      });
      const macBase = `http://127.0.0.1:${(mac.address() as AddressInfo).port}`;
      const { base, accounts } = await cloud.ready;
      /** The Mac's own Settings → Connect your Mac screen (loopback owner routes). */
      const local = async (route: string, payload?: object) => {
        const res = await fetch(`${macBase}/api/remote/${route}`, {
          method: payload ? "POST" : "GET",
          headers: payload ? { "content-type": "application/json" } : undefined,
          body: payload ? JSON.stringify(payload) : undefined,
          signal: AbortSignal.timeout(STEP_MS),
        });
        return { status: res.status, body: (await res.json()) as RemoteStatus };
      };
      const listMacs = async (account: Account) => {
        const res = await fetch(`${base}/api/relay/macs`, {
          headers: { authorization: `Bearer ${account.token}` },
          signal: AbortSignal.timeout(STEP_MS),
        });
        assert.equal(res.status, 200);
        return ((await res.json()) as { hosts: Array<MacTarget & { online: boolean }> }).hosts;
      };
      const phone = (account: Account, host: MacTarget, name: string) => {
        const p = new Phone({ cloud: base, token: account.token, host, name });
        phones.push(p);
        return p;
      };

      // 1. Discovery. The Mac signs in to the relay as Alice; only Alice's phone lists it,
      //    and Bob cannot reach it by id either.
      const connected = await local("connect", { base, session: accounts.alice.token });
      assert.equal(connected.status, 200);
      assert.equal(connected.body.enabled, true);
      const [host] = await eventually(
        () => listMacs(accounts.alice),
        (hosts) => hosts.length === 1,
      );
      assert.ok(host);
      assert.equal(host.id, connected.body.hostId);
      assert.equal(keyId(host.publicKey), host.id);
      assert.equal(host.online, true);
      assert.deepEqual(await listMacs(accounts.bob), []);
      await eventually(
        () => local("status"),
        (s) => s.body.online,
      );
      await assert.rejects(phone(accounts.bob, host, "Bob's iPhone").connect(), LinkClosedError);

      // 2. Pairing v2: commitment → Mac nonce → reveal → the same code on both screens.
      const iphone = phone(accounts.alice, host, "Test iPhone");
      const round = await iphone.startPairing();
      assert.equal(round.welcome.v, 2);
      assert.equal(round.welcome.authorized, false);
      assert.equal(round.welcome.code, undefined, "a v2 Mac never sends the uncommitted code");
      assert.deepEqual(round.welcome.lanURLs, [], "no LAN hints before approval");
      assert.equal(typeof round.welcome.nonce, "string");
      // Listed, but with no code to compare until the phone opens its commitment.
      assert.deepEqual(
        (await local("status")).body.pending.map((p) => [p.id, p.code, p.waiting]),
        [[iphone.id, "", true]],
      );
      const code = await round.reveal();
      assert.deepEqual(
        (await local("status")).body.pending.map((p) => [p.id, p.code, p.secure]),
        [[iphone.id, code, true]],
      );
      const approved = await local("approve", { id: iphone.id, code });
      assert.equal(approved.status, 200);
      assert.deepEqual(
        approved.body.devices.map((d) => [d.id, d.secure]),
        [[iphone.id, true]],
      );
      assert.deepEqual(approved.body.pending, []);
      // Pocket's next poll of the pairing screen sees the grant.
      const poll = await iphone.connect();
      assert.equal(poll.welcome.authorized, true);
      poll.close();

      // 3. Through the tunnel. A REST read Pocket makes, with the API version header intact.
      const sessions = await iphone.request("/api/agents/sessions");
      assert.equal(sessions.status, 200);
      assert.match(sessions.headers["content-type"] ?? "", /^application\/json/);
      assert.equal(sessions.headers["x-lisa-api-version"], LISA_API_VERSION);
      assert.ok(Array.isArray((JSON.parse(sessions.body) as { sessions: unknown }).sessions));

      // /events opens with hello and the current mood; it stays open for step 4.
      const events = await iphone.open("/events");
      assert.equal(events.status, 200);
      assert.match(events.headers["content-type"] ?? "", /^text\/event-stream/);
      assert.equal((await events.event())?.type, "hello");
      assert.equal((await events.event())?.type, "mood");

      // A streamed chat: the model's text, then done, then the channel's end.
      const chat = await iphone.open("/chat", {
        method: "POST",
        body: { message: "Hello over the relay", expressions: true },
      });
      assert.equal(chat.status, 200);
      assert.match(chat.headers["content-type"] ?? "", /^text\/event-stream/);
      const streamed: Frame[] = [];
      for (let e = await chat.event(); e; e = await chat.event()) streamed.push(e);
      assert.equal(
        streamed
          .filter((e) => e.type === "text")
          .map((e) => e.text)
          .join(""),
        REPLY,
      );
      assert.equal(streamed.at(-1)?.type, "done");
      assert.ok(prompts.some((p) => p.includes("Hello over the relay")));

      // Stop mid-reply: Pocket closes the channel, and the Mac aborts that turn.
      const held = await iphone.open("/chat", {
        method: "POST",
        body: { message: HOLD, expressions: true },
      });
      let partial: Frame | undefined;
      do partial = await held.event();
      while (partial && partial.type !== "text");
      assert.equal(partial?.text, "Let me think");
      held.close();
      await within(heldAborted, STEP_MS, "the Mac aborting the cancelled turn");
      await within(held.link.closed, STEP_MS, "the cancelled channel closing");
      await eventually(
        () => local("status"),
        (s) => s.body.activeConnections === 1, // just /events
      );
      // The abandoned turn does not hold up the next one.
      const next = await iphone.request("/chat", {
        method: "POST",
        body: { message: "Still there?", expressions: true },
      });
      assert.equal(next.status, 200);
      assert.ok(next.body.includes(REPLY));

      // 4. Revocation on the Mac closes the phone's open stream and refuses what follows.
      const revoked = await local("revoke", { id: iphone.id });
      assert.equal(revoked.status, 200);
      assert.deepEqual(revoked.body.devices, []);
      await within(events.link.closed, STEP_MS, "the revoked phone's /events stream closing");
      await assert.rejects(iphone.request("/api/agents/sessions"), NotAllowedError);
      // A phone that ignores the welcome gets its channel closed, with no response.
      const ignored = await iphone.connect();
      assert.equal(ignored.welcome.authorized, false);
      ignored.send({
        type: "request",
        id: crypto.randomUUID(),
        challenge: ignored.welcome.challenge,
        expiresAt: Date.now() + 60_000,
        path: "/api/agents/sessions",
        method: "GET",
        body: "",
      });
      await assert.rejects(ignored.receive(), LinkClosedError);
      assert.deepEqual((await local("status")).body.pending, [], "reconnects raise no new prompt");

      // 5. LAN with the relay stopped. A second phone pairs and reads the conversation
      //    through the relay, which is also where Pocket learns the Mac's LAN URLs.
      const ipad = phone(accounts.alice, host, "Test iPad");
      const ipadCode = await ipad.pair();
      assert.equal((await local("approve", { id: ipad.id, code: ipadCode })).status, 200);
      const viaRelay = await ipad.request("/api/history?page=0");
      assert.equal(viaRelay.status, 200);
      assert.ok(viaRelay.body.includes(REPLY));
      // The LAN listener binds 0.0.0.0 on the port the Mac keeps in remote-link.json.
      // Advertised URLs carry that port, but a host without an en*/eth*/wlan* interface
      // advertises none, and host firewalls (macOS stealth mode, CI sandboxes) often drop
      // a socket to the machine's own LAN IP, so dial the same listener over loopback.
      const saved = JSON.parse(fs.readFileSync(path.join(macHome, "remote-link.json"), "utf8")) as {
        lanPort?: number;
      };
      assert.ok(saved.lanPort, "the Mac saved its LAN port");
      for (const url of ipad.lanURLs)
        assert.match(url, new RegExp(`^ws://(?:\\d{1,3}\\.){3}\\d{1,3}:${saved.lanPort}/link$`));
      const lan = `ws://127.0.0.1:${saved.lanPort}/link`;

      await cloud.stop();
      await eventually(
        () => local("status"),
        (s) => !s.body.online,
      );
      const viaLan = await ipad.request("/api/history?page=0", { lan });
      assert.equal(viaLan.status, 200);
      assert.equal(viaLan.headers["x-lisa-api-version"], LISA_API_VERSION);
      assert.deepEqual(JSON.parse(viaLan.body), JSON.parse(viaRelay.body));
      // The LAN route never re-admits the revoked phone.
      await assert.rejects(iphone.connect({}, lan), LinkClosedError);
    } finally {
      for (const p of phones) p.dispose();
      try {
        await cloud.stop();
        if (mac) {
          const server = mac;
          server.closeAllConnections();
          await within(
            new Promise<void>((resolve) => server.close(() => resolve())),
            STEP_MS,
            "Mac server close",
          );
        }
      } finally {
        fs.rmSync(root, { recursive: true, force: true, maxRetries: 10, retryDelay: 50 });
      }
    }
  },
);
