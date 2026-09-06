// ESLint flat config (ESLint 10 + typescript-eslint 8).
//
// Type-aware rules run against tsconfig.eslint.json rather than
// parserOptions.projectService: projectService only discovers files that some
// tsconfig.json *includes*, and tsconfig.json (the build config, also used
// verbatim by scripts/build-release.sh) excludes every *.test.ts. The
// projectService escape hatch (allowDefaultProject) is capped at a handful of
// files and forbids `**` globs, so it cannot carry 190+ test files.
import js from "@eslint/js";
import { defineConfig, globalIgnores } from "eslint/config";
import globals from "globals";
import tseslint from "typescript-eslint";

// ── Baseline ────────────────────────────────────────────────────────────
// Pre-existing violations in files that other work streams are editing right
// now (T-4 review, 2026-09). Each entry downgrades ONE rule to `warn` for the
// files that still violate it, so `npm run lint` is error-free today without
// a cross-stream refactor. Shrink this list as files are cleaned up; do not
// add to it — new code must pass the rules at `error`.
const baseline = [
  {
    rule: "no-console",
    files: [
      "src/billing/iap.ts",
      "src/billing/limits.ts",
      "src/billing/media-meter.ts",
      "src/billing/stripe.ts",
      "src/channels/discord.ts",
      "src/channels/feishu.ts",
      "src/channels/imessage.ts",
      "src/channels/router.ts",
      "src/channels/slack.ts",
      "src/channels/telegram.ts",
      "src/channels/webhook.ts",
      "src/cloud/turn-lease.ts",
      "src/heartbeat/runner.ts",
      "src/idle/runner.ts",
      "src/integrations/claude-code/observer.ts",
      "src/kb/feeds/classify.ts",
      "src/kb/feeds/service.ts",
      "src/kb/feeds/store.ts",
      "src/providers/fallback.ts",
      "src/reflect.ts",
      "src/sandbox/sandbox.ts",
      "src/soul/git.ts",
      "src/web/accounts.ts",
    ],
  },
  {
    rule: "no-empty",
    files: ["src/autostart/install.ts", "src/cli.ts", "src/web/server.ts"],
  },
  {
    rule: "no-useless-assignment",
    files: ["src/integrations/claude-code/watcher.ts", "src/soul/birth.ts", "src/web/server.ts"],
  },
  {
    rule: "no-useless-escape",
    files: ["src/web/lisa-client.ts"],
  },
  {
    rule: "prefer-const",
    files: ["src/billing/quota.test.ts", "src/web/server.ts"],
  },
  {
    rule: "@typescript-eslint/no-explicit-any",
    files: [
      "src/integrations/takoapi/a2a.ts",
      "src/tools/github.ts",
      "src/tools/mcp.test.ts",
      "src/tools/npm_info.ts",
      "src/tools/takoapi.ts",
    ],
  },
  {
    rule: "@typescript-eslint/no-misused-promises",
    files: ["src/cli.ts", "src/cli/repl.ts", "src/web/server.ts"],
  },
  {
    rule: "@typescript-eslint/no-unnecessary-type-assertion",
    files: [
      "src/billing/meter.test.ts",
      "src/billing/quota.ts",
      "src/cli.ts",
      "src/cli/account.ts",
      "src/cli/sense.ts",
      "src/integrations/claude-code/parser-steps.test.ts",
      "src/integrations/claude-code/parser.ts",
      "src/web/server.ts",
    ],
  },
];

export default defineConfig([
  globalIgnores([
    "dist/**",
    "dist-release/**",
    "node_modules/**",
    "coverage/**",
    "website/**",
    "research/**",
    "packaging/**",
    "deploy/**",
    "docs/**",
    "src/web/assets/**",
    "**/*.generated.ts",
    "playwright-report/**",
    "test-results/**",
    ".claude/**",
  ]),

  js.configs.recommended,

  // Plain-JS tooling (scripts/*.mjs, this file) — Node globals, no type info.
  {
    files: ["**/*.{js,mjs,cjs}"],
    languageOptions: { globals: globals.node },
  },

  // TypeScript: recommended + the type-aware rules that matter.
  {
    files: ["**/*.ts"],
    extends: [tseslint.configs.recommended],
    languageOptions: {
      parserOptions: {
        project: "./tsconfig.eslint.json",
        tsconfigRootDir: import.meta.dirname,
      },
    },
    rules: {
      "@typescript-eslint/no-floating-promises": [
        "error",
        {
          // node:test's test()/describe()/hooks return promises that the runner
          // itself tracks; awaiting them at top level would be wrong.
          allowForKnownSafeCalls: [
            {
              from: "package",
              package: "node:test",
              name: [
                "test",
                "describe",
                "it",
                "suite",
                "before",
                "after",
                "beforeEach",
                "afterEach",
              ],
            },
          ],
        },
      ],
      "@typescript-eslint/no-misused-promises": "error",
      "@typescript-eslint/await-thenable": "error",
      "@typescript-eslint/no-unnecessary-type-assertion": "error",
      // `_`-prefixed names are the house convention for deliberately unused
      // parameters and rest-destructuring discards.
      "@typescript-eslint/no-unused-vars": [
        "error",
        {
          args: "after-used",
          argsIgnorePattern: "^_",
          varsIgnorePattern: "^_",
          caughtErrorsIgnorePattern: "^_",
          destructuredArrayIgnorePattern: "^_",
          ignoreRestSiblings: true,
        },
      ],
    },
  },

  // House rules (all files).
  {
    rules: {
      "no-empty": ["error", { allowEmptyCatch: false }],
      "no-console": "error",
      // `== null` / `!= null` is the idiomatic "null or undefined" check here.
      eqeqeq: ["error", "always", { null: "ignore" }],
      "prefer-const": "error",
    },
  },

  // Surfaces whose job is to print: the CLI, the logger, dev scripts, tests.
  {
    files: ["src/cli.ts", "src/cli/**", "src/log.ts", "scripts/**", "**/*.test.ts", "tests/**"],
    rules: { "no-console": "off" },
  },

  ...baseline.map(({ rule, files }) => ({ files, rules: { [rule]: "warn" } })),
]);
