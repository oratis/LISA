import { test, describe } from "node:test";
import assert from "node:assert/strict";
import { buildScreencaptureArgs, captureSupported } from "./capture.js";

describe("buildScreencaptureArgs", () => {
  test("interactive mode → -x -i -o <path>", () => {
    const args = buildScreencaptureArgs("interactive", "/tmp/shot.png");
    assert.deepEqual(args, ["-x", "-i", "-o", "/tmp/shot.png"]);
  });

  test("full mode → -x <path> (no -i)", () => {
    const args = buildScreencaptureArgs("full", "/tmp/shot.png");
    assert.deepEqual(args, ["-x", "/tmp/shot.png"]);
  });

  test("output path is always the LAST argument", () => {
    for (const mode of ["interactive", "full"] as const) {
      const args = buildScreencaptureArgs(mode, "/tmp/x.png");
      assert.equal(args[args.length - 1], "/tmp/x.png");
    }
  });

  test("always silences the shutter (-x present)", () => {
    assert.ok(buildScreencaptureArgs("interactive", "/p").includes("-x"));
    assert.ok(buildScreencaptureArgs("full", "/p").includes("-x"));
  });

  test("the path is a single argv element — no shell, no injection surface", () => {
    const tricky = "/tmp/a b; rm -rf ~/.png";
    const args = buildScreencaptureArgs("full", tricky);
    assert.equal(args[args.length - 1], tricky, "path passed verbatim as one arg");
  });
});

describe("captureSupported", () => {
  test("matches the platform (darwin only)", () => {
    assert.equal(captureSupported(), process.platform === "darwin");
  });
});

import fs from "node:fs/promises";
import path from "node:path";
import { captureScreenshot } from "./capture.js";
import { normalizeCaptureContext } from "./context.js";

test("image-only capture never reads AX; opted-in context precedes capture and private temp data is removed", async () => {
  const order: string[] = [],
    files: string[] = [];
  const deps = {
    supported: () => true,
    context: async () => {
      order.push("context");
      return { status: "ready" as const, text: "窗口" };
    },
    capture: async (args: string[]) => {
      order.push("capture");
      files.push(args.at(-1)!);
      await fs.writeFile(args.at(-1)!, "image");
    },
  };
  const image = await captureScreenshot("full", false, deps);
  assert.deepEqual(order, ["capture"]);
  assert.equal(image?.context, undefined);
  order.length = 0;
  const withContext = await captureScreenshot("interactive", true, deps);
  assert.deepEqual(order, ["context", "capture"]);
  assert.deepEqual(withContext?.context, { status: "ready", text: "窗口" });
  assert.equal(withContext?.data, Buffer.from("image").toString("base64"));
  assert.notEqual(files[0], files[1]);
  for (const file of files) await assert.rejects(fs.access(path.dirname(file)));
});

test("cancel, native failure and missing context permissions leave no capture file", async () => {
  let file = "";
  const cancel = await captureScreenshot("interactive", true, {
    supported: () => true,
    context: async () => ({ status: "permission_required" }),
    capture: async (args) => {
      file = args.at(-1)!;
    },
  });
  assert.equal(cancel, null);
  await assert.rejects(fs.access(path.dirname(file)));
  const fallback = await captureScreenshot("full", true, {
    supported: () => true,
    context: async () => {
      throw Error("unavailable");
    },
    capture: async (args) => {
      file = args.at(-1)!;
      await fs.writeFile(file, "png");
    },
  });
  assert.deepEqual(fallback?.context, { status: "unavailable" });
  await assert.rejects(fs.access(path.dirname(file)));
  await assert.rejects(
    captureScreenshot("full", false, {
      supported: () => true,
      capture: async (args) => {
        file = args.at(-1)!;
        await fs.writeFile(file, "partial");
        throw Error("failed");
      },
    }),
    /failed/,
  );
  await assert.rejects(fs.access(path.dirname(file)));
});

test("context projection bounds text/coordinates, strips secure controls and keeps permission failures empty", () => {
  const bounds = { x: -100, y: 20, width: 800, height: 600 };
  const raw = {
    status: "ready",
    app: "Editor",
    window: "窗口 <script>",
    bounds,
    elements: [
      { role: "AXSecureTextField", text: "password-secret", bounds },
      { role: "AXTextField", subrole: "AXSecureTextField", text: "password-secret", bounds },
      { role: "AXTextArea", text: "你好\u0000world", bounds },
      { role: "AXTextField", text: "invalid-bounds", bounds: { ...bounds, width: -1 } },
      ...Array.from({ length: 101 }, () => ({
        role: "AXTextArea",
        text: "x".repeat(1000),
        bounds,
      })),
    ],
  };
  const result = normalizeCaptureContext(raw, "2026-11-15T00:00:00Z");
  assert.equal(result.status, "ready");
  assert.match(result.text!, /global screen points/);
  assert.match(result.text!, /你好world/);
  assert.match(result.text!, /Context truncated/);
  assert.doesNotMatch(result.text!, /password-secret|invalid-bounds/);
  assert.equal(result.text!.includes("\u0000"), false);
  assert.ok(result.text!.length < 20000);
  assert.deepEqual(normalizeCaptureContext({ ...raw, status: "permission_required" }), {
    status: "permission_required",
  });
  assert.deepEqual(normalizeCaptureContext({ ...raw, bounds: {} }), { status: "unavailable" });
});
