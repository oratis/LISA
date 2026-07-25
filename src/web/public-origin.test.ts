import { describe, test } from "node:test";
import assert from "node:assert/strict";
import {
  configuredPublicOrigin,
  requireCloudPublicOrigin,
  verificationUrl,
} from "./public-origin.js";

describe("canonical public origin", () => {
  test("normalizes a valid origin", () => {
    assert.equal(
      configuredPublicOrigin(
        { LISA_PUBLIC_ORIGIN: " https://cloud.meetlisa.ai/ " } as NodeJS.ProcessEnv,
        "cloud",
      ),
      "https://cloud.meetlisa.ai",
    );
  });

  test("cloud requires a configured HTTPS origin", () => {
    assert.throws(() => requireCloudPublicOrigin({}), /required/);
    assert.throws(
      () => requireCloudPublicOrigin({ LISA_PUBLIC_ORIGIN: "http://cloud.meetlisa.ai" }),
      /https in the cloud edition/,
    );
  });

  test("rejects credentials and URL components beyond the origin", () => {
    for (const value of [
      "https://user:pass@cloud.meetlisa.ai",
      "https://cloud.meetlisa.ai/a",
      "https://cloud.meetlisa.ai?next=evil",
      "https://cloud.meetlisa.ai#fragment",
      "javascript:alert(1)",
    ]) {
      assert.throws(
        () => configuredPublicOrigin({ LISA_PUBLIC_ORIGIN: value } as NodeJS.ProcessEnv, "cloud"),
        value,
      );
    }
  });

  test("verification links encode the token under the canonical origin", () => {
    assert.equal(
      verificationUrl("https://cloud.meetlisa.ai", "raw token&next=https://evil.example"),
      "https://cloud.meetlisa.ai/verify?token=raw+token%26next%3Dhttps%3A%2F%2Fevil.example",
    );
  });
});
