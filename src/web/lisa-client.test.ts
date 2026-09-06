import { test, describe } from "node:test";
import assert from "node:assert/strict";
import { createContext, runInContext } from "node:vm";
import { MAIN_CLIENT_JS } from "./lisa-client.js";

// Regression guard for the idle "while you were away" sentinel regex.
//
// The client source lives inside MAIN_CLIENT_JS, a plain (untagged) template
// literal, so backslashes are consumed once when the literal is evaluated. A
// regex written with SINGLE backslashes cooks down to a character class plus a
// literal "s*" instead of the intended literal "[while you were away]" prefix.
// Because the persisted sentinel starts with "[", and "[" is not inside that
// character class, `.test()` returns false and history-loaded idle notes fall
// through to a plain Lisa bubble showing the raw sentinel text instead of the
// distinct idle card. The fix is to DOUBLE-escape in source so it cooks to the
// correct regex. `npm run typecheck` can't see this — the template literal is
// valid TypeScript either way — so we assert on the cooked bytes here.
// MAIN_CLIENT_JS is imported already-cooked, i.e. exactly what the browser gets.
//
// See lisa-client.ts:~718 (detection + strip) and the correct `\\s+` precedent
// at lisa-client.ts:~1061.
//
// (This test file deliberately keeps the regex out of any block comment: the
// pattern contains the `*` + `/` pair that would prematurely close one — the
// very same "one layer of escaping/quoting eats your metacharacters" trap.)

const CORRECT_LITERAL = "/^\\[while you were away\\]\\s*/i"; // cooked: caret, \[ , text, \] , \s star, /i
const BROKEN_LITERAL = "/^[while you were away]s*/i"; // what single-escaping cooks down to

describe("idle-note sentinel regex survives template-literal cooking", () => {
  test("cooked source carries the correct regex, not the mangled one", () => {
    const hits = MAIN_CLIENT_JS.split(CORRECT_LITERAL).length - 1;
    // Two uses: the `.test()` detection and the `.replace()` that strips the prefix.
    assert.ok(
      hits >= 2,
      `expected the correctly-escaped sentinel regex at least twice, found ${hits}`,
    );
    assert.ok(
      !MAIN_CLIENT_JS.includes(BROKEN_LITERAL),
      "MAIN_CLIENT_JS contains the mangled sentinel regex — a single-backslash " +
        "escape was eaten by the template literal",
    );
  });

  test("the served regex actually detects and strips a persisted idle note", () => {
    // Pull the regex literal straight out of the cooked source and run it, so we
    // exercise the exact bytes the browser gets rather than a hand-copied regex.
    const m = MAIN_CLIENT_JS.match(/\/\^[^/\n]*while you were away[^/\n]*\/i/);
    assert.ok(m, "could not locate the idle-note regex literal in MAIN_CLIENT_JS");
    const lit = m[0];
    const lastSlash = lit.lastIndexOf("/");
    const sentinel = new RegExp(lit.slice(1, lastSlash), lit.slice(lastSlash + 1));

    const note = "[while you were away] I tidied your notes while you were out.";
    assert.ok(
      sentinel.test(note),
      `served regex ${sentinel} failed to match a real idle note`,
    );
    assert.equal(
      note.replace(sentinel, ""),
      "I tidied your notes while you were out.",
      "served regex did not strip the [while you were away] prefix cleanly",
    );

    // A normal Lisa reply must not be mistaken for an idle note.
    assert.ok(
      !sentinel.test("Welcome back! Here's what I found."),
      "served regex wrongly flagged a normal reply as an idle note",
    );
  });
});

/**
 * Behavioural tests for individual client functions.
 *
 * The client is one big template literal, so there is no module to import
 * and no DOM in `npm test`. These pull a named function's exact served text
 * out of MAIN_CLIENT_JS and run it in a `vm` sandbox with hand-made stubs —
 * so what is tested is literally what the browser executes.
 */
/** The i18n block, so a sandbox renders the real strings rather than stubs. */
const I18N_SRC = MAIN_CLIENT_JS.slice(
  MAIN_CLIENT_JS.indexOf("const LISA_STRINGS = {"),
  MAIN_CLIENT_JS.indexOf("const log = document.getElementById('log');"),
);
function i18nContext(extra: Record<string, unknown> = {}) {
  return createContext({
    navigator: { language: "en-US" },
    document: { documentElement: {} },
    ...extra,
  });
}

function extractFunction(src: string, name: string): string {
  const head = `function ${name}(`;
  const start = src.indexOf(head);
  assert.ok(start >= 0, `function ${name} not found in MAIN_CLIENT_JS`);
  let depth = 0;
  let i = src.indexOf("{", start);
  assert.ok(i >= 0, `function ${name} has no body`);
  for (let j = i; j < src.length; j++) {
    if (src[j] === "{") depth++;
    else if (src[j] === "}") {
      depth--;
      if (depth === 0) return src.slice(start, j + 1);
    }
  }
  throw new Error(`unbalanced braces in ${name}`);
}

describe("sessionLabel names an empty session instead of showing its raw id (UX-4)", () => {
  const src = extractFunction(MAIN_CLIENT_JS, "sessionLabel");
  const ctx = i18nContext({ relativeTime: (iso: string) => (iso ? "2m" : "") });
  runInContext(`${I18N_SRC}\n${src}; globalThis.__label = sessionLabel;`, ctx);
  const label = (ctx as { __label: (s: unknown) => string }).__label;
  const ID = "20260905-220846-9f7d58";

  test("a session with no messages reads as a new session, not the id", () => {
    assert.equal(label({ id: ID, messageCount: 0, startedAt: "2026-09-05T22:08:46Z" }), "New session · 2m");
  });
  test("the first user message still wins once there is one", () => {
    assert.equal(label({ id: ID, messageCount: 1, firstUserMessage: "fix the mail sweep" }), "fix the mail sweep");
  });
  test("long names are ellipsised to 30 chars", () => {
    const long = "a".repeat(80);
    assert.equal(label({ id: ID, messageCount: 3, firstUserMessage: long }), "a".repeat(30) + "…");
  });
  test("a session with messages but no captured text falls back to the id", () => {
    assert.equal(label({ id: ID, messageCount: 4 }), ID);
  });
});

describe("collapsed right rail keeps a way in (UX-5)", () => {
  test("the manual toggle records that the user has a preference", () => {
    assert.match(
      MAIN_CLIENT_JS,
      /localStorage\.setItem\('lisaRightbarTouched', '1'\)/,
      "the #fnPanel click handler must persist lisaRightbarTouched",
    );
    assert.match(
      MAIN_CLIENT_JS,
      /localStorage\.getItem\('lisaRightbarTouched'\) === '1'/,
      "the flag must be read back at boot",
    );
  });

  test("the auto-expand nudge never writes the layout preference", () => {
    // It is a one-time nudge for someone who has never touched the toggle.
    // If it ever persisted 'lisaRightbar', a single blocked agent would
    // permanently change a layout the user did not choose.
    const start = MAIN_CLIENT_JS.indexOf("window.lisaRightbarAttention = function");
    assert.ok(start >= 0, "lisaRightbarAttention not found");
    const end = MAIN_CLIENT_JS.indexOf("\n  };", start);
    const body = MAIN_CLIENT_JS.slice(start, end);
    assert.ok(!body.includes("setItem"), `auto-expand must not persist: ${body}`);
    assert.match(body, /!touched && !autoExpanded/, "must be gated on both flags");
  });

  test("the needs-you renderer feeds it, and only a decision expands the rail", () => {
    assert.match(
      MAIN_CLIENT_JS,
      /window\.lisaRightbarAttention\(needs\.length, needs\.some\(function \(s\) \{\s*return \(s\.activity && s\.activity\.pendingPermission\) \|\| s\.state === 'waiting';/,
      "an errored agent must be counted but must not auto-expand the rail",
    );
  });
});

describe("birth errors are classified into human copy (UX-1)", () => {
  // The copy comes from the i18n table now, so the sandbox needs that block
  // too — which also means these assertions run against the real strings.
  const src =
    MAIN_CLIENT_JS.slice(
      MAIN_CLIENT_JS.indexOf("const BIRTH_ERROR_TEXT = {"),
      MAIN_CLIENT_JS.indexOf("function showBirthError("),
    );
  const ctx = i18nContext();
  runInContext(`${I18N_SRC}\n${src}; globalThis.__code = birthErrorCode; globalThis.__text = BIRTH_ERROR_TEXT;`, ctx);
  const code = (ctx as { __code: (ev: unknown) => string }).__code;
  const text = (ctx as { __text: Record<string, string> }).__text;

  test("a new server's explicit code wins", () => {
    assert.equal(code({ kind: "error", code: "rate_limit", message: "whatever" }), "rate_limit");
  });
  test("an unknown code falls back to classification rather than being trusted", () => {
    assert.equal(code({ code: "teapot", message: "401 nope" }), "auth");
  });
  test("an old server's raw Anthropic 401 payload classifies as auth", () => {
    const raw =
      '401 {"type":"error","error":{"type":"authentication_error","message":"invalid x-api-key"},"request_id":null}';
    assert.equal(code({ kind: "error", message: raw }), "auth");
  });
  test("network, timeout and rate-limit shapes are recognised without a code", () => {
    assert.equal(code({ message: "ECONNREFUSED 127.0.0.1:443" }), "network");
    assert.equal(code({ message: "fetch failed" }), "network");
    assert.equal(code({ message: "request timed out after 600000ms" }), "timeout");
    assert.equal(code({ message: "429 rate_limit_error" }), "rate_limit");
  });
  test("anything else is unknown, never rendered raw", () => {
    assert.equal(code({ message: "kaboom" }), "unknown");
    assert.equal(code({}), "unknown");
    assert.equal(code(null), "unknown");
  });
  test("every class has copy, and none of it is JSON", () => {
    for (const k of ["auth", "timeout", "network", "rate_limit", "unknown"]) {
      assert.ok(text[k] && text[k].length > 20, `missing copy for ${k}`);
      assert.ok(!text[k]!.includes("{"), `copy for ${k} leaks a payload`);
    }
  });
  test("the raw payload goes to the title attribute, never to textContent", () => {
    const show = MAIN_CLIENT_JS.slice(
      MAIN_CLIENT_JS.indexOf("function showBirthError("),
      MAIN_CLIENT_JS.indexOf("async function maybeBirth("),
    );
    assert.match(show, /birthErrorEl\.textContent = BIRTH_ERROR_TEXT\[code\]/);
    assert.match(show, /birthErrorEl\.title = String\(\(ev && ev\.message\)/);
  });
});

describe("provider picker works against both server generations (UX-1)", () => {
  const src = MAIN_CLIENT_JS.slice(
    MAIN_CLIENT_JS.indexOf("const LISA_PROVIDER_FALLBACK = ["),
    MAIN_CLIENT_JS.indexOf("// ── API key config gate"),
  );
  const ctx = i18nContext({ window: {} });
  runInContext(`${I18N_SRC}\n${src}`, ctx);
  const c = ctx as {
    lisaProviderList: (s: unknown) => Array<Record<string, unknown>>;
    lisaProviderSaveBody: (p: unknown, k: string, m: string, b: string) => Record<string, unknown>;
    lisaProviderConfirm: (p: unknown, s: unknown) => boolean | null;
  };

  test("an old status (no providers block) falls back to the built-in table", () => {
    const list = c.lisaProviderList({ configured: true, anthropic: true, openai: false });
    assert.ok(list.length >= 8, `only ${list.length} providers`);
    const ids = list.map((p) => p.id);
    for (const want of ["anthropic", "openai", "deepseek", "zhipu", "dashscope", "moonshot", "gemini", "custom"]) {
      assert.ok(ids.includes(want), `missing ${want}`);
    }
    assert.equal(list.find((p) => p.id === "anthropic")!.configured, true);
    assert.equal(list.find((p) => p.id === "openai")!.configured, false);
  });

  test("a served providers block wins, including providers this client has never heard of", () => {
    const list = c.lisaProviderList({
      providers: [
        { id: "zhipu", envKey: "ZHIPU_API_KEY", label: "Zhipu GLM", modelPrefixes: ["glm-"], configured: true },
        { id: "brandnew", envKey: "BRANDNEW_API_KEY", label: "Brand New Co", modelPrefixes: ["bn-"], configured: false },
      ],
    });
    assert.equal(JSON.stringify(list.map((p) => p.id)), JSON.stringify(["zhipu", "brandnew"]));
    assert.equal(list[0]!.configured, true);
    // Local presentation hints still merge in for the ones we know.
    assert.equal(list[0]!.model, "glm-4-plus");
    assert.equal(list[1]!.placeholder, "key...");
  });

  test("the save body carries the new shape plus every legacy field name", () => {
    const anthropic = c.lisaProviderList(null).find((p) => p.id === "anthropic")!;
    const body = c.lisaProviderSaveBody(anthropic, "sk-ant-x", "", "");
    assert.equal(JSON.stringify(body.keys), JSON.stringify({ ANTHROPIC_API_KEY: "sk-ant-x" }));
    assert.equal(body.anthropicKey, "sk-ant-x");
    assert.equal(body.anthropic, "sk-ant-x");
    const openai = c.lisaProviderList(null).find((p) => p.id === "openai")!;
    const b2 = c.lisaProviderSaveBody(openai, "sk-o", "gpt-4o", "");
    assert.equal(b2.openaiKey, "sk-o");
    assert.equal(b2.openai, "sk-o");
    assert.equal(b2.model, "gpt-4o");
    // A third-party provider gets no legacy field — there is none to send.
    const ds = c.lisaProviderList(null).find((p) => p.id === "deepseek")!;
    const b3 = c.lisaProviderSaveBody(ds, "sk-d", "deepseek-chat", "");
    assert.equal(JSON.stringify(Object.keys(b3).sort()), JSON.stringify(["keys", "model"]));
    const custom = c.lisaProviderList(null).find((p) => p.id === "custom")!;
    assert.equal(c.lisaProviderSaveBody(custom, "k", "m", "https://h/v1").baseUrl, "https://h/v1");
  });

  test("only providers the server cannot auto-detect pin a model", () => {
    const byId = (id: string) => c.lisaProviderList(null).find((p) => p.id === id)!;
    // Anthropic and OpenAI are resolved from the key alone by
    // providers/registry.resolveDefaultModel; the rest would silently fall
    // back to Claude if LISA_MODEL were left unset.
    assert.equal(byId("anthropic").needsModel, false);
    assert.equal(byId("openai").needsModel, false);
    for (const id of ["deepseek", "zhipu", "dashscope", "moonshot", "gemini", "custom"]) {
      assert.equal(byId(id).needsModel, true, `${id} must pin a model`);
    }
  });

  test("confirm reports false only when we KNOW the server dropped the key", () => {
    const ds = c.lisaProviderList(null).find((p) => p.id === "deepseek")!;
    // Old server, third-party key: it cannot have kept it.
    assert.equal(c.lisaProviderConfirm(ds, { configured: false, anthropic: false }), false);
    // Old server, Anthropic key it did keep.
    const an = c.lisaProviderList(null).find((p) => p.id === "anthropic")!;
    assert.equal(c.lisaProviderConfirm(an, { anthropic: true }), true);
    // New server that lists the provider.
    const st = { providers: [{ id: "deepseek", envKey: "DEEPSEEK_API_KEY", configured: true }] };
    assert.equal(c.lisaProviderConfirm(ds, st), true);
    // New server that does not list it at all — unknowable, never block.
    assert.equal(c.lisaProviderConfirm({ envKey: "NOPE" }, st), null);
  });
});

describe("interface language table (UX-8)", () => {
  const ctxEn = i18nContext();
  runInContext(`${I18N_SRC}; globalThis.__tr = tr; globalThis.__loc = LISA_LOCALE;`, ctxEn);
  const ctxZh = createContext({ navigator: { language: "zh-CN" }, document: { documentElement: {} } });
  runInContext(`${I18N_SRC}; globalThis.__tr = tr; globalThis.__loc = LISA_LOCALE;`, ctxZh);
  const en = ctxEn as { __tr: (k: string, v?: Record<string, unknown>) => string; __loc: string };
  const zh = ctxZh as { __tr: (k: string, v?: Record<string, unknown>) => string; __loc: string };

  test("navigator.language picks the locale, and document.lang follows", () => {
    assert.equal(en.__loc, "en");
    assert.equal(zh.__loc, "zh-CN");
    assert.equal((ctxEn as { document: { documentElement: { lang?: string } } }).document.documentElement.lang, "en");
    assert.equal((ctxZh as { document: { documentElement: { lang?: string } } }).document.documentElement.lang, "zh-CN");
  });

  test("both tables define exactly the same keys", () => {
    const keys = (c: object) => {
      const ctx = createContext({ navigator: { language: "en" }, document: { documentElement: {} } });
      runInContext(`${I18N_SRC}; globalThis.__k = Object.keys(LISA_STRINGS.en).sort().join(","); globalThis.__z = Object.keys(LISA_STRINGS['zh-CN']).sort().join(",");`, ctx);
      return ctx as { __k: string; __z: string };
    };
    const k = keys({});
    assert.equal(k.__k, k.__z, "en and zh-CN tables have drifted apart");
  });

  test("interpolation and fallback both work", () => {
    assert.equal(en.__tr("rail.needs.many", { n: 3 }), "3 agents need you");
    assert.equal(zh.__tr("rail.needs.many", { n: 3 }), "3 个 agent 在等你");
    // An unknown key returns the key rather than "undefined" on screen.
    assert.equal(en.__tr("nope.nope"), "nope.nope");
  });

  test("the client carries no leftover CJK string literals", () => {
    // Comments are fine; user-visible literals are not. The QQ/163 mailbox
    // help quotes those providers' own Chinese UI labels ("设置", "授权码")
    // and must stay as-is, so it is the one allowed island.
    const cjk = /[一-鿿぀-ヿ가-힯]/;
    const offenders: string[] = [];
    for (const line of MAIN_CLIENT_JS.split("\n")) {
      const code = line.replace(/\/\/.*$/, "");
      if (!cjk.test(code)) continue;
      if (/授权码|设置|服务|账户/.test(code)) continue; // QQ / 163 provider labels
      // idleHeaderLabel keeps ja/ko, which predate the table (en + zh-CN only).
      if (/indexOf\('(ja|ko)'\)/.test(code)) continue;
      if (code.includes("LISA_STRINGS") || code.includes("'zh-CN'")) continue;
      offenders.push(line.trim());
    }
    // Everything else must live in the zh-CN half of LISA_STRINGS, which sits
    // between these two markers.
    const zhStart = MAIN_CLIENT_JS.indexOf("'zh-CN': {");
    const zhEnd = MAIN_CLIENT_JS.indexOf("const LISA_LOCALE");
    const inTable = offenders.filter((l) => {
      const at = MAIN_CLIENT_JS.indexOf(l);
      return at > zhStart && at < zhEnd;
    });
    assert.deepEqual(
      offenders.filter((l) => !inTable.includes(l)),
      [],
    );
  });
});

describe("no call site of the i18n helper is left un-renamed (UX-8)", () => {
  test("the served source has no bare t(...) call", () => {
    // "t" is a local in twenty places in this file, so a t(...) call reaching
    // the i18n helper by accident — or a tr(...) call that was missed — is a
    // silent TypeError only a browser would show. Scan the cooked bytes.
    const offenders = MAIN_CLIENT_JS.split("\n").filter((line) => {
      const code = line.replace(/\/\/.*$/, "");
      return /[^A-Za-z0-9_$.]t\(/.test(code);
    });
    assert.deepEqual(offenders, []);
  });
});

describe("backend liveness is surfaced (UX-10)", () => {
  test("every /events frame and the open event count as liveness", () => {
    assert.match(MAIN_CLIENT_JS, /es\.addEventListener\('open', noteEventBytes\)/);
    assert.match(MAIN_CLIENT_JS, /es\.addEventListener\('message', \(e\) => \{\s*noteEventBytes\(\);/);
    assert.match(MAIN_CLIENT_JS, /es\.onerror = \(\) => \{[\s\S]{0,120}setConnPill\(true\)/);
  });
  test("the quiet window is 45s and a quiet-but-open socket is probed, not assumed dead", () => {
    assert.match(MAIN_CLIENT_JS, /const CONN_QUIET_MS = 45_000;/);
    const fn = MAIN_CLIENT_JS.slice(
      MAIN_CLIENT_JS.indexOf("async function checkConnection()"),
      MAIN_CLIENT_JS.indexOf("setInterval(checkConnection, 5000)"),
    );
    // readyState !== OPEN is decided locally; only the half-open case costs a
    // request, and that one is rate-limited.
    assert.match(fn, /es\.readyState !== 1 \) \{ setConnPill\(true\); return; \}|es\.readyState !== 1\) \{ setConnPill\(true\); return; \}/);
    assert.match(fn, /fetch\('\/health'/);
    assert.match(fn, /connProbeAt < 30_000/);
  });
  test("the 2s chat escalation is armed on send and disarmed on the first frame and in finally", () => {
    const fn = MAIN_CLIENT_JS.slice(
      MAIN_CLIENT_JS.indexOf("async function runChat("),
      MAIN_CLIENT_JS.indexOf("// ── send"),
    );
    assert.match(fn, /let waitTimer = setTimeout\(function \(\) \{[\s\S]*?\}, 2000\);/);
    assert.match(fn, /noteFrame\(\);/);
    // Two clears: the first frame, and the finally that ends the turn.
    assert.equal((fn.match(/clearTimeout\(waitTimer\)/g) || []).length, 2);
  });
});

describe("small fixes (UX-11)", () => {
  const ctx = i18nContext();
  runInContext(`${I18N_SRC}\n${extractFunction(MAIN_CLIENT_JS, "abbrevPath")}; globalThis.__ab = abbrevPath;`, ctx);
  const ab = (ctx as { __ab: (p: unknown) => string }).__ab;

  test("home directories abbreviate to ~, everything else is left alone", () => {
    assert.equal(ab("/Users/oratis/Projects/LISA"), "~/Projects/LISA");
    assert.equal(ab("/Users/oratis"), "~");
    assert.equal(ab("/home/deploy/app"), "~/app");
    assert.equal(ab("/opt/lisa"), "/opt/lisa");
    assert.equal(ab("/UsersOfSomething/x"), "/UsersOfSomething/x");
    assert.equal(ab(""), "");
    assert.equal(ab(null), "");
  });

  test("the Sense view only claims publishing state when a connector exists", () => {
    // "Publishing active · Pause publishing" on a fresh install implied there
    // was something to pause.
    assert.match(
      MAIN_CLIENT_JS,
      /var html = connectors\.length\s*\?\s*'<div class="social-policy">/,
      "the policy row must be gated on connectors.length",
    );
    assert.match(MAIN_CLIENT_JS, /social-policy neutral[\s\S]{0,80}sense\.noConnector/);
  });

  test("the pairing panel states the token's lifetime", () => {
    assert.match(MAIN_CLIENT_JS, /class="pair-note"/);
    const ctx2 = i18nContext();
    runInContext(`${I18N_SRC}; globalThis.__tr = tr;`, ctx2);
    const note = (ctx2 as { __tr: (k: string) => string }).__tr("pair.noExpiry");
    assert.match(note, /does not expire/);
  });

  test("the inspector's cwd row is abbreviated, tooltipped and copyable", () => {
    const fn = extractFunction(MAIN_CLIENT_JS, "inspPathRow");
    assert.match(fn, /inspRow\(label, abbrevPath\(value\)\)/);
    assert.match(fn, /code\.title = value/);
    assert.match(fn, /copyButton\(function \(\) \{ return value; \}/);
    assert.match(MAIN_CLIENT_JS, /kv\.appendChild\(inspPathRow\('cwd', s\.cwd\)\)/);
  });
});
