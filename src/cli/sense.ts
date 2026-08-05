/**
 * `lisa sense <list>` — print recent ambient sense events + which signals are
 * granted (FOUNDATIONS §4 observability: "one `lisa <domain>` command per
 * pillar"). Read-only over the bounded sense log; structural summaries only.
 */
import { readSenseEvents } from "../sense/log.js";
import { listGrants } from "../consent/store.js";
import { discoverSocialConnectors } from "../sense/social/manifest.js";
import { listSocialDrafts } from "../sense/social/drafts.js";
import { installBundledOpenConnector } from "../sense/social/connectors/plugin.js";
import { runOpenSocialConnectorServer, type OpenConnectorPlatform } from "../sense/social/connectors/server.js";
import { connectBlueskyAccount } from "../sense/social/connectors/bluesky.js";
import { connectMastodonAccount } from "../sense/social/connectors/mastodon.js";
import { publicAccount } from "../sense/social/connectors/accounts.js";
import { stageSocialMedia } from "../sense/social/media.js";
import {
  COMMERCIAL_ADAPTER_PROFILES,
  evaluateCommercialReadiness,
} from "../sense/social/connectors/commercial.js";
import fs from "node:fs/promises";
import readline from "node:readline";

function rel(ms: number): string {
  if (ms < 60_000) return `${Math.round(ms / 1000)}s ago`;
  if (ms < 3_600_000) return `${Math.round(ms / 60_000)}m ago`;
  if (ms < 86_400_000) return `${Math.round(ms / 3_600_000)}h ago`;
  return `${Math.round(ms / 86_400_000)}d ago`;
}

export async function runSenseCommand(subargs: string[]): Promise<number> {
  const sub = subargs[0] ?? "list";

  if (sub === "social") {
    const action = subargs[1];
    if (action === "serve-connector") {
      const platform = subargs[2];
      if (platform !== "bluesky" && platform !== "mastodon") {
        console.error("connector platform must be bluesky or mastodon");
        return 2;
      }
      await runOpenSocialConnectorServer(platform);
      return 0;
    }
    if (action === "install") {
      const requested = subargs
        .slice(2)
        .filter((value) => value !== "--force");
      const platforms = (requested.length ? requested : ["bluesky", "mastodon"]) as OpenConnectorPlatform[];
      if (platforms.some((value) => value !== "bluesky" && value !== "mastodon")) {
        console.error("usage: lisa sense social install [bluesky] [mastodon] [--force]");
        return 2;
      }
      for (const platform of platforms) {
        const root = await installBundledOpenConnector(
          platform,
          subargs.includes("--force"),
        );
        console.log(`installed ${platform}: ${root}`);
      }
      console.log("Restart the LISA server to load the connector MCP servers and skills.");
      return 0;
    }
    if (action === "connect") {
      const platform = subargs[2];
      if (!process.stdin.isTTY) {
        console.error("account linking needs an interactive TTY so credentials are not passed in argv");
        return 2;
      }
      if (platform === "bluesky") {
        const handle = subargs[3] ?? await ask("Bluesky handle: ");
        const service = subargs[4];
        const password = await ask("Bluesky app password: ", true);
        try {
          const account = await connectBlueskyAccount(handle, password, service);
          console.log(JSON.stringify(publicAccount(account), null, 2));
        } finally {
          closePrompt();
        }
        return 0;
      }
      if (platform === "mastodon") {
        const instance = subargs[3] ?? await ask("Mastodon instance (e.g. mastodon.social): ");
        const token = await ask("Mastodon user access token: ", true);
        try {
          const account = await connectMastodonAccount(instance, token);
          console.log(JSON.stringify(publicAccount(account), null, 2));
        } finally {
          closePrompt();
        }
        return 0;
      }
      console.error("usage: lisa sense social connect <bluesky|mastodon> [handle|instance]");
      return 2;
    }
    if (action === "media" && subargs[2] === "add") {
      const file = subargs[3];
      if (!file) {
        console.error("usage: lisa sense social media add <file> [--alt <text>]");
        return 2;
      }
      const altIndex = subargs.indexOf("--alt");
      const ref = await stageSocialMedia(
        await fs.readFile(file),
        undefined,
        altIndex >= 0 ? subargs[altIndex + 1] : undefined,
      );
      console.log(JSON.stringify(ref, null, 2));
      return 0;
    }
    if (action === "readiness") {
      console.log("Sense · Commercial connector readiness\n");
      for (const platform of Object.keys(COMMERCIAL_ADAPTER_PROFILES) as Array<
        keyof typeof COMMERCIAL_ADAPTER_PROFILES
      >) {
        const readiness = evaluateCommercialReadiness(platform, {
          oauthClientConfigured: false,
          redirectOriginConfigured: false,
          platformReviewApproved: false,
        });
        const profile = COMMERCIAL_ADAPTER_PROFILES[platform];
        console.log(`${profile.displayName.padEnd(16)} ${readiness.state}`);
        for (const gate of profile.externalGates) console.log(`  external: ${gate}`);
        if (profile.pricingNotice) console.log(`  notice: ${profile.pricingNotice}`);
      }
      console.log(
        "\nThese adapters remain draft-only until a connector owns OAuth, passes platform review, and satisfies media delivery gates.",
      );
      return 0;
    }
    const [connectors, drafts] = await Promise.all([
      discoverSocialConnectors(),
      listSocialDrafts(),
    ]);
    console.log("Sense · Connected media\n");
    console.log("Connectors:");
    if (connectors.length === 0) {
      console.log("  (none — install a plugin with social-connector.json)");
    } else {
      for (const connector of connectors) {
        if (connector.manifest) {
          console.log(
            `  ✓ ${connector.manifest.displayName} [${connector.manifest.platform}] via ${connector.plugin}`,
          );
        } else {
          console.log(`  ✗ ${connector.plugin}: ${connector.error ?? "invalid manifest"}`);
        }
      }
    }
    console.log("\nDrafts:");
    if (drafts.length === 0) {
      console.log("  (none)");
    } else {
      for (const draft of drafts.slice(-20).reverse()) {
        const targets = draft.targets
          .map((target) => `${target.platform}:${target.accountId}`)
          .join(", ");
        console.log(
          `  ${draft.id.slice(0, 8)}  r${draft.revision}  ${draft.state.padEnd(17)} ${targets}`,
        );
      }
    }
    console.log(
      "\nPublishing remains host-confirmed: connecting an account never authorizes an automatic post.",
    );
    return 0;
  }

  if (sub === "list" || sub === "recent" || sub === "status") {
    const granted = listGrants().filter((g) => g.granted).map((g) => g.signal);
    console.log(`Sense — granted: ${granted.length ? granted.join(", ") : "(none; all off — `lisa consent grant <signal>`)"}\n`);
    const events = readSenseEvents();
    if (events.length === 0) {
      console.log("  (no recent ambient events)");
      return 0;
    }
    const now = Date.now();
    for (const e of events.slice(-30).reverse()) {
      console.log(`  ${rel(now - e.ts).padStart(8)}  [${e.signal}] ${e.summary}`);
    }
    return 0;
  }

  console.error(`unknown sense subcommand "${sub}" — use list or social.`);
  return 1;
}

let prompt: readline.Interface | null = null;
function ask(question: string, hidden = false): Promise<string> {
  prompt ??= readline.createInterface({
    input: process.stdin,
    output: process.stderr,
    terminal: true,
  });
  return new Promise((resolve) => {
    if (!hidden) {
      prompt!.question(question, resolve);
      return;
    }
    const stream = process.stderr;
    const original = stream.write.bind(stream);
    let muted = false;
    (stream as unknown as { write: typeof original }).write = ((chunk: never, ...rest: never[]) => {
      if (muted) return true;
      return original(chunk, ...rest);
    }) as typeof original;
    prompt!.question(question, (answer) => {
      (stream as unknown as { write: typeof original }).write = original;
      original("\n");
      resolve(answer);
    });
    muted = true;
  });
}

function closePrompt(): void {
  prompt?.close();
  prompt = null;
}
