import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { afterEach, beforeEach, describe, test } from "node:test";
import {
  approveSocialDraft,
  canonicalJson,
  claimApprovedSocialDraft,
  createSocialDraft,
  listSocialDrafts,
  requestSocialDraftApproval,
  socialDraftDigest,
  updateSocialDraft,
} from "./drafts.js";
import type { NewSocialDraft } from "./types.js";

let home: string;
let previousHome: string | undefined;

beforeEach(() => {
  previousHome = process.env.LISA_HOME;
  home = fs.mkdtempSync(path.join(os.tmpdir(), "lisa-social-drafts-"));
  process.env.LISA_HOME = home;
});

afterEach(() => {
  if (previousHome === undefined) delete process.env.LISA_HOME;
  else process.env.LISA_HOME = previousHome;
  fs.rmSync(home, { recursive: true, force: true });
});

function input(): NewSocialDraft {
  return {
    targets: [
      {
        connectorId: "bluesky-official",
        accountId: "did:plc:alice",
        platform: "bluesky",
        visibility: "public",
      },
    ],
    canonical: {
      text: "Hello",
      link: "https://example.com",
      media: [],
    },
  };
}

describe("social drafts", () => {
  test("canonical JSON is stable across object key order", () => {
    assert.equal(
      canonicalJson({ z: 1, a: { y: 2, x: 3 } }),
      canonicalJson({ a: { x: 3, y: 2 }, z: 1 }),
    );
  });

  test("creates a 0600 store without tokens or media bytes", async () => {
    const draft = await createSocialDraft(input(), 1000);
    assert.equal(draft.state, "draft");
    assert.equal((await listSocialDrafts()).length, 1);
    const file = path.join(home, "sense", "social", "drafts.json");
    assert.equal(fs.statSync(file).mode & 0o777, 0o600);
    const raw = fs.readFileSync(file, "utf8");
    assert.doesNotMatch(raw, /access[_-]?token|refresh[_-]?token/i);
  });

  test("editing invalidates an approval request and changes the digest", async () => {
    const created = await createSocialDraft(input(), 1000);
    const requested = await requestSocialDraftApproval(created.id, 1, 2000);
    const updated = await updateSocialDraft(
      created.id,
      1,
      { canonical: { text: "Changed", media: [] } },
      3000,
    );
    assert.equal(updated.state, "draft");
    assert.equal(updated.approval, undefined);
    assert.notEqual(socialDraftDigest(updated), requested.digest);
    await assert.rejects(
      approveSocialDraft(created.id, requested.digest, 4000),
      /cannot be approved/,
    );
  });

  test("digest mismatch is rejected", async () => {
    const draft = await createSocialDraft(input(), 1000);
    await requestSocialDraftApproval(draft.id, 1, 2000);
    await assert.rejects(
      approveSocialDraft(draft.id, "0".repeat(64), 3000),
      /changed after preview/,
    );
  });

  test("approval can be claimed exactly once", async () => {
    const draft = await createSocialDraft(input(), 1000);
    const { digest } = await requestSocialDraftApproval(draft.id, 1, 2000);
    await approveSocialDraft(draft.id, digest, 3000);
    const claimed = await claimApprovedSocialDraft(draft.id, digest, 4000);
    assert.equal(claimed.state, "publishing");
    await assert.rejects(
      claimApprovedSocialDraft(draft.id, digest, 5000),
      /is not publishable/,
    );
  });

  test("expired approval fails closed", async () => {
    const draft = await createSocialDraft(input(), 1000);
    const { digest } = await requestSocialDraftApproval(draft.id, 1, 2000);
    await approveSocialDraft(draft.id, digest, 3000, 100);
    await assert.rejects(
      claimApprovedSocialDraft(draft.id, digest, 3100),
      /approval expired/,
    );
  });
});
