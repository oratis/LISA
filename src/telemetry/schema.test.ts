import assert from "node:assert/strict";
import path from "node:path";
import { describe, test } from "node:test";
import { fileURLToPath } from "node:url";
import ts from "typescript";
import {
  CLOUD_ONLY_EVENTS,
  COUNT_BUCKETS,
  DAY_BUCKETS,
  EMITTERS,
  EVENT_POLICY,
  EVENT_PROPERTY_SPECS,
  INGRESS_EVENTS,
  INGRESS_MODES,
  LOCAL_ONLY_EVENTS,
  MS_BUCKETS,
  RATE_BUCKETS,
  TELEMETRY_EVENT_NAMES,
  TOK_BUCKETS,
  UPLOAD_MODES,
  UPLOADABLE_EVENTS,
  countBucket,
  dayBucket,
  getEventPolicy,
  msBucket,
  normalizePlatform,
  normalizeProviderFamily,
  normalizeSlashCommand,
  rateBucket,
  sanitizeTelemetryEvent,
  tokBucket,
  type TelemetryEventName,
} from "./schema.js";

const HERE = path.dirname(fileURLToPath(import.meta.url));
const REPO_ROOT = path.resolve(HERE, "..", "..");

const SOUL_TOKENS = new Set([
  "desire",
  "journal",
  "opinion",
  "relationship",
  "identity",
  "purpose",
  "constitution",
  "value",
  "emotion",
  "memory",
  "reflection",
]);

const CONTENT_TOKENS = new Set([
  "text",
  "content",
  "prompt",
  "message",
  "body",
  "snippet",
  "title",
  "slug",
  "name",
  "path",
  "cwd",
  "repo",
  "url",
  "email",
  "host",
  "file",
]);

const MONEY_TOKENS = new Set([
  "credit",
  "purchase",
  "balance",
  "quota",
  "window",
  "blocked",
  "premium",
  "paid",
  "refund",
  "stripe",
  "iap",
]);

function splitTokens(ident: string): string[] {
  return ident
    .replace(/([a-z0-9])([A-Z])/g, "$1_$2")
    .toLowerCase()
    .split(/[^a-z0-9]+/)
    .filter(Boolean);
}

describe("telemetry buckets — exhaustive boundary and invalid-input invariants", () => {
  test("msBucket covers both sides of every boundary plus non-finite/negative values", () => {
    const cases: Array<[number, string]> = [
      [-100, "<1s"],
      [0, "<1s"],
      [999, "<1s"],
      [1_000, "1-5s"],
      [4_999, "1-5s"],
      [5_000, "5-30s"],
      [29_999, "5-30s"],
      [30_000, "30s-2m"],
      [119_999, "30s-2m"],
      [120_000, "2-10m"],
      [599_999, "2-10m"],
      [600_000, "10-60m"],
      [3_599_999, "10-60m"],
      [3_600_000, ">1h"],
      [Number.NaN, "<1s"],
      [Number.NEGATIVE_INFINITY, "<1s"],
      [Number.POSITIVE_INFINITY, ">1h"],
    ];
    for (const [input, expected] of cases) {
      const out = msBucket(input);
      assert.equal(out, expected, `msBucket(${String(input)})`);
      assert.ok((MS_BUCKETS as readonly string[]).includes(out));
    }
  });

  test("tokBucket covers both sides of every boundary plus non-finite/negative values", () => {
    const cases: Array<[number, string]> = [
      [-1, "<1k"],
      [0, "<1k"],
      [999, "<1k"],
      [1_000, "1-5k"],
      [4_999, "1-5k"],
      [5_000, "5-20k"],
      [19_999, "5-20k"],
      [20_000, "20-100k"],
      [99_999, "20-100k"],
      [100_000, "100k+"],
      [Number.NaN, "<1k"],
      [Number.NEGATIVE_INFINITY, "<1k"],
      [Number.POSITIVE_INFINITY, "100k+"],
    ];
    for (const [input, expected] of cases) {
      const out = tokBucket(input);
      assert.equal(out, expected, `tokBucket(${String(input)})`);
      assert.ok((TOK_BUCKETS as readonly string[]).includes(out));
    }
  });

  test("dayBucket covers both sides of every boundary plus non-finite/negative values", () => {
    const cases: Array<[number, string]> = [
      [-5, "0"],
      [0, "0"],
      [0.9, "0"],
      [1, "1"],
      [1.9, "1"],
      [2, "2-6"],
      [6, "2-6"],
      [7, "7-29"],
      [29, "7-29"],
      [30, "30-89"],
      [89, "30-89"],
      [90, "90+"],
      [Number.NaN, "0"],
      [Number.NEGATIVE_INFINITY, "0"],
      [Number.POSITIVE_INFINITY, "90+"],
    ];
    for (const [input, expected] of cases) {
      const out = dayBucket(input);
      assert.equal(out, expected, `dayBucket(${String(input)})`);
      assert.ok((DAY_BUCKETS as readonly string[]).includes(out));
    }
  });

  test("countBucket covers both sides of every boundary plus non-finite/negative values", () => {
    const cases: Array<[number, string]> = [
      [-3, "0"],
      [0, "0"],
      [0.5, "0"],
      [1, "1"],
      [2, "2-3"],
      [3, "2-3"],
      [4, "4-9"],
      [9, "4-9"],
      [10, "10-29"],
      [29, "10-29"],
      [30, "30-99"],
      [99, "30-99"],
      [100, "100+"],
      [Number.NaN, "0"],
      [Number.NEGATIVE_INFINITY, "0"],
      [Number.POSITIVE_INFINITY, "100+"],
    ];
    for (const [input, expected] of cases) {
      const out = countBucket(input);
      assert.equal(out, expected, `countBucket(${String(input)})`);
      assert.ok((COUNT_BUCKETS as readonly string[]).includes(out));
    }
  });

  test("rateBucket covers both sides of every boundary plus non-finite/negative values", () => {
    const cases: Array<[number, string]> = [
      [-0.2, "0"],
      [0, "0"],
      [0.01, "1-25%"],
      [0.25, "1-25%"],
      [0.26, "26-50%"],
      [0.5, "26-50%"],
      [0.51, "51-75%"],
      [0.75, "51-75%"],
      [0.76, "76-99%"],
      [0.99, "76-99%"],
      [1, "100%"],
      [1.2, "100%"],
      [Number.NaN, "0"],
      [Number.NEGATIVE_INFINITY, "0"],
      [Number.POSITIVE_INFINITY, "100%"],
    ];
    for (const [input, expected] of cases) {
      const out = rateBucket(input);
      assert.equal(out, expected, `rateBucket(${String(input)})`);
      assert.ok((RATE_BUCKETS as readonly string[]).includes(out));
    }
  });
});

describe("telemetry normalizers — collapse user/plugin strings to closed enums", () => {
  test("normalizeSlashCommand collapses plugin and unknown commands without leaking names", () => {
    assert.equal(normalizeSlashCommand("help"), "help");
    assert.equal(normalizeSlashCommand("/think"), "think");
    assert.equal(normalizeSlashCommand("deploy-acme-prod", true), "plugin");
    assert.equal(normalizeSlashCommand("secret-internal-cmd", false), "unknown");
  });

  test("normalizeProviderFamily collapses custom preset names into ProviderFamily", () => {
    assert.equal(normalizeProviderFamily("claude-sonnet-4-6"), "anthropic");
    assert.equal(normalizeProviderFamily("gpt-4o"), "openai");
    assert.equal(normalizeProviderFamily("o3-mini"), "openai");
    assert.equal(normalizeProviderFamily("gemini-2.5-pro"), "google");
    assert.equal(normalizeProviderFamily("local://llama3"), "local");
    assert.equal(normalizeProviderFamily("my-company-internal-llama"), "other");
  });

  test("normalizePlatform maps unknown platforms to other", () => {
    assert.equal(normalizePlatform("darwin"), "darwin");
    assert.equal(normalizePlatform("linux"), "linux");
    assert.equal(normalizePlatform("win32"), "win32");
    assert.equal(normalizePlatform("freebsd"), "other");
  });
});

describe("EVENT_POLICY — fail-closed declaration and token-safety invariants", () => {
  test("all required core local lifecycle events are registered", () => {
    const required: TelemetryEventName[] = [
      "birth_completed",
      "session_started",
      "turn_completed",
      "task_created",
      "task_run_finished",
      "approval_decided",
      "connector_authorized",
      "cli_command_run",
    ];
    for (const name of required) {
      assert.ok(TELEMETRY_EVENT_NAMES.includes(name), `missing required event: ${name}`);
      assert.ok(getEventPolicy(name) !== null);
    }
  });

  test("getEventPolicy fails closed for unknown and prototype keys", () => {
    assert.equal(getEventPolicy("nonexistent_event"), null);
    assert.equal(getEventPolicy("__proto__"), null);
    assert.equal(getEventPolicy("constructor"), null);
    assert.equal(getEventPolicy("toString"), null);
    assert.equal(getEventPolicy(""), null);
  });

  test("EVENT_POLICY and EVENT_PROPERTY_SPECS cover identical event sets and valid policy values", () => {
    assert.deepEqual(Object.keys(EVENT_PROPERTY_SPECS).sort(), [...TELEMETRY_EVENT_NAMES].sort());
    for (const name of TELEMETRY_EVENT_NAMES) {
      const p = EVENT_POLICY[name];
      assert.ok((EMITTERS as readonly string[]).includes(p.emitter), `${name} invalid emitter`);
      assert.ok(
        (INGRESS_MODES as readonly string[]).includes(p.ingress),
        `${name} invalid ingress`,
      );
      assert.ok((UPLOAD_MODES as readonly string[]).includes(p.upload), `${name} invalid upload`);
      assert.ok(p.editions.length > 0, `${name} must allow at least one edition`);
    }
    const union = new Set([...UPLOADABLE_EVENTS, ...LOCAL_ONLY_EVENTS]);
    assert.equal(union.size, TELEMETRY_EVENT_NAMES.length);
    for (const name of LOCAL_ONLY_EVENTS) {
      assert.ok(!UPLOADABLE_EVENTS.includes(name));
    }
  });

  test("cloud billing/quota events and MONEY_TOKENS events are strictly internal", () => {
    const cloudMoneyEvents: TelemetryEventName[] = [
      "free_window_opened",
      "free_window_exhausted",
      "premium_model_blocked",
      "credit_pack_purchased",
      "account_created",
    ];
    for (const name of cloudMoneyEvents) {
      assert.ok(!INGRESS_EVENTS.includes(name), `${name} must not be ingress`);
      assert.ok(CLOUD_ONLY_EVENTS.includes(name), `${name} must be cloud-only`);
      assert.deepEqual(EVENT_POLICY[name].editions, ["cloud"]);
    }

    for (const name of TELEMETRY_EVENT_NAMES) {
      const tokens = [
        ...splitTokens(name),
        ...Object.keys(EVENT_PROPERTY_SPECS[name]).flatMap(splitTokens),
      ];
      if (tokens.some((t) => MONEY_TOKENS.has(t))) {
        assert.equal(
          EVENT_POLICY[name].ingress,
          "internal",
          `money/quota event ${name} must enforce ingress: "internal"`,
        );
      }
      if (tokens.some((t) => SOUL_TOKENS.has(t) || CONTENT_TOKENS.has(t))) {
        assert.equal(
          EVENT_POLICY[name].upload,
          "never",
          `soul/content-named event ${name} must enforce upload: "never"`,
        );
      }
    }
  });
});

describe("TypeScript AST guard — zero raw string or number properties in TelemetryEvent", () => {
  test("every property across the TelemetryEvent union resolves strictly to string literals or boolean", () => {
    const tsconfigPath = path.join(REPO_ROOT, "tsconfig.eslint.json");
    const rawConfig = ts.readConfigFile(tsconfigPath, (p) => ts.sys.readFile(p));
    assert.equal(rawConfig.error, undefined);
    const parsed = ts.parseJsonConfigFileContent(rawConfig.config, ts.sys, REPO_ROOT);
    const program = ts.createProgram(parsed.fileNames, parsed.options);
    const checker = program.getTypeChecker();

    const schemaPath = path.join(HERE, "schema.ts");
    const sourceFile = program.getSourceFile(schemaPath);
    assert.ok(sourceFile, `could not load ${schemaPath} in TS program`);

    let telemetryEventDecl: ts.TypeAliasDeclaration | undefined;
    ts.forEachChild(sourceFile, (node) => {
      if (ts.isTypeAliasDeclaration(node) && node.name.text === "TelemetryEvent") {
        telemetryEventDecl = node;
      }
    });
    assert.ok(telemetryEventDecl, "TelemetryEvent type alias not found");

    const unionType = checker.getTypeAtLocation(telemetryEventDecl);
    assert.ok(unionType.isUnion(), "TelemetryEvent must be a discriminated union");

    const seenNames = new Set<string>();

    const assertSafePropertyType = (eventName: string, propName: string, t: ts.Type): void => {
      if (t.isUnion()) {
        for (const member of t.types) {
          // Optional properties include `undefined` under strictNullChecks.
          if ((member.flags & ts.TypeFlags.Undefined) !== 0) continue;
          assertSafePropertyType(eventName, propName, member);
        }
        return;
      }
      const isLiteralString = t.isStringLiteral();
      const isBoolean = (t.flags & (ts.TypeFlags.Boolean | ts.TypeFlags.BooleanLiteral)) !== 0;
      assert.ok(
        isLiteralString || isBoolean,
        `${eventName}.properties.${propName} has disallowed type "${checker.typeToString(t)}" — only fixed string-literal enums, buckets, and boolean are permitted`,
      );
    };

    for (const arm of unionType.types) {
      const nameSym = arm.getProperty("name");
      assert.ok(nameSym, "TelemetryEvent union arm missing name");
      const nameType = checker.getTypeOfSymbolAtLocation(nameSym, telemetryEventDecl);
      assert.ok(nameType.isStringLiteral(), "TelemetryEvent arm name must be a string literal");
      const eventName = nameType.value as TelemetryEventName;
      seenNames.add(eventName);

      const propsSym = arm.getProperty("properties");
      assert.ok(propsSym, `${eventName} missing properties`);
      const propsType = checker.getTypeOfSymbolAtLocation(propsSym, telemetryEventDecl);
      const specMap = EVENT_PROPERTY_SPECS[eventName];
      assert.ok(specMap, `${eventName} missing EVENT_PROPERTY_SPECS entry`);

      const astPropNames = new Set<string>();
      for (const propSym of propsType.getProperties()) {
        const propName = propSym.getName();
        astPropNames.add(propName);
        const propType = checker.getTypeOfSymbolAtLocation(propSym, telemetryEventDecl);
        assertSafePropertyType(eventName, propName, propType);

        const spec = specMap[propName];
        assert.ok(spec, `${eventName}.${propName} missing from EVENT_PROPERTY_SPECS`);
        const isOptional = (propSym.flags & ts.SymbolFlags.Optional) !== 0;
        assert.equal(
          Boolean(spec.optional),
          isOptional,
          `${eventName}.${propName} optionality mismatch between TS union and EVENT_PROPERTY_SPECS`,
        );

        if (spec.kind === "enum") {
          const allowed = new Set<string>();
          const collect = (t: ts.Type): void => {
            if (t.isUnion()) {
              for (const sub of t.types) {
                if ((sub.flags & ts.TypeFlags.Undefined) === 0) collect(sub);
              }
            } else if (t.isStringLiteral()) {
              allowed.add(t.value);
            }
          };
          collect(propType);
          assert.deepEqual(
            [...spec.values].sort(),
            [...allowed].sort(),
            `${eventName}.${propName} runtime enum values drifted from TypeScript union`,
          );
        }
      }

      assert.deepEqual(
        Object.keys(specMap).sort(),
        [...astPropNames].sort(),
        `${eventName} EVENT_PROPERTY_SPECS keys drifted from TypeScript union`,
      );
    }

    assert.deepEqual([...seenNames].sort(), [...TELEMETRY_EVENT_NAMES].sort());
  });
});

describe("sanitizeTelemetryEvent — fail-closed validation and redaction", () => {
  test("accepts valid core lifecycle events and strips undeclared sensitive keys", () => {
    const clean = sanitizeTelemetryEvent({
      name: "turn_completed",
      properties: {
        surface: "cli",
        tokens: tokBucket(2500),
        toolCalls: countBucket(2),
        provider: "anthropic",
        stopReason: "end",
        prompt: "SECRET_PROMPT_TEXT",
        reply: "SECRET_REPLY_TEXT",
        cwd: "/Users/alice/secret-repo",
        url: "https://internal.corp/secret",
        apiKey: "sk-ant-secret",
      },
    });
    assert.deepEqual(clean, {
      name: "turn_completed",
      properties: {
        surface: "cli",
        tokens: "1-5k",
        toolCalls: "2-3",
        provider: "anthropic",
        stopReason: "end",
      },
    });
  });

  test("rejects unknown events, prototype pollution, wrong editions, and raw strings in declared fields", () => {
    assert.equal(sanitizeTelemetryEvent(null), null);
    assert.equal(sanitizeTelemetryEvent([]), null);
    assert.equal(sanitizeTelemetryEvent({ name: "bogus", properties: {} }), null);
    assert.equal(sanitizeTelemetryEvent({ name: "toString", properties: {} }), null);
    assert.equal(sanitizeTelemetryEvent({ name: "birth_completed", properties: [] }), null);

    // Wrong edition fail closed
    assert.equal(
      sanitizeTelemetryEvent(
        {
          name: "birth_completed",
          properties: {
            durationMs: "<1s",
            provider: "anthropic",
            tokens: "<1k",
            retried: false,
          },
        },
        { edition: "cloud" },
      ),
      null,
    );
    assert.equal(
      sanitizeTelemetryEvent(
        { name: "free_window_opened", properties: { tier: "free" } },
        { edition: "mac" },
      ),
      null,
    );

    // Raw string / planted secret inside a declared enum/bucket field -> fail closed
    assert.equal(
      sanitizeTelemetryEvent({
        name: "cli_command_run",
        properties: {
          command: "rm -rf /secret",
          ok: true,
          durationMs: "<1s",
        },
      }),
      null,
    );

    // Missing required field or invalid boolean -> fail closed
    assert.equal(
      sanitizeTelemetryEvent({
        name: "task_created",
        properties: { kind: "routine", hasSchedule: "yes", hasTrigger: false, hasEnvelope: false },
      }),
      null,
    );
  });
});
