/**
 * Vision — screen capture.
 *
 * Lets the user hand LISA a screenshot to look at and talk about. On macOS we
 * shell out to the built-in `screencapture` utility, which gives us, for free:
 *   - interactive region/window selection (the familiar ⇧⌘4 crosshair)
 *   - a full-screen grab
 *   - Escape-to-cancel (screencapture writes no file → we return null)
 *
 * The captured PNG is written to a temp file, read into base64, then deleted.
 * The returned object is the exact shape the /chat endpoint already accepts
 * for attachments ({ name, mediaType, data }), so the whole downstream
 * image-chat path is reused unchanged.
 *
 * Privacy: the screenshot only leaves the machine when the user sends the
 * chat message it's attached to — same as any other attachment. Nothing is
 * captured or transmitted without the explicit hotkey/button press.
 */

import { spawn } from "node:child_process";
import fsp from "node:fs/promises";
import os from "node:os";
import path from "node:path";

export type CaptureMode = "interactive" | "full";

export interface CapturedImage {
  name: string;
  mediaType: "image/png";
  /** base64-encoded PNG bytes (no data: prefix). */
  data: string;
}

/**
 * Build the `screencapture` argv for a given mode + output path.
 * Pure + tested.
 *   interactive → -i  (crosshair: drag a region, or space to pick a window;
 *                       Escape cancels and writes no file)
 *   full        → (no flag: whole screen)
 * -x silences the camera shutter sound; -o omits window shadow on window grabs.
 */
export function buildScreencaptureArgs(mode: CaptureMode, outPath: string): string[] {
  const args = ["-x"];
  if (mode === "interactive") args.push("-i", "-o");
  args.push(outPath);
  return args;
}

/** True on macOS, where `screencapture` exists. */
export function captureSupported(): boolean {
  return process.platform === "darwin";
}

/**
 * Capture a screenshot. Resolves to the attachment object, or null if the
 * user cancelled (Escape) — screencapture exits 0 but writes no file in that
 * case, which we detect by the missing output.
 * Throws only on an unexpected failure (binary missing, write error).
 */
export async function captureScreenshot(
  mode: CaptureMode = "interactive",
): Promise<CapturedImage | null> {
  if (!captureSupported()) {
    throw new Error("screen capture is only supported on macOS");
  }
  const stamp = new Date().toISOString().replace(/[:.]/g, "-").slice(0, 19);
  const outPath = path.join(os.tmpdir(), `lisa-shot-${stamp}-${process.pid}.png`);
  const args = buildScreencaptureArgs(mode, outPath);

  await new Promise<void>((resolve, reject) => {
    const child = spawn("/usr/sbin/screencapture", args);
    let stderr = "";
    child.stderr.on("data", (b) => (stderr += b.toString("utf8")));
    child.on("error", reject);
    child.on("close", (code) =>
      code === 0
        ? resolve()
        : reject(new Error(`screencapture exited ${code}: ${stderr.trim()}`)),
    );
  });

  // Escape-to-cancel: no file written.
  let data: string;
  try {
    const buf = await fsp.readFile(outPath);
    if (buf.length === 0) {
      await fsp.rm(outPath, { force: true }).catch(() => {});
      return null;
    }
    data = buf.toString("base64");
  } catch {
    return null; // cancelled / nothing captured
  } finally {
    await fsp.rm(outPath, { force: true }).catch(() => {});
  }

  return {
    name: `screenshot-${stamp}.png`,
    mediaType: "image/png",
    data,
  };
}
