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
import { readCaptureContext, type CaptureContext } from "./context.js";

export type CaptureMode = "interactive" | "full";

export interface CapturedImage {
  name: string;
  mediaType: "image/png";
  /** base64-encoded PNG bytes (no data: prefix). */
  data: string;
  /** Kept in preview only; the user must separately choose to attach this text. */
  context?: CaptureContext;
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
  includeContext = false,
  dependencies: {
    supported?: () => boolean;
    context?: () => Promise<CaptureContext>;
    capture?: (args: string[]) => Promise<void>;
  } = {},
): Promise<CapturedImage | null> {
  if (!(dependencies.supported ?? captureSupported)()) {
    throw new Error("screen capture is only supported on macOS");
  }
  const stamp = new Date().toISOString().replace(/[:.]/g, "-").slice(0, 19);
  const temp = await fsp.mkdtemp(path.join(os.tmpdir(), "lisa-shot-"));
  const outPath = path.join(temp, "capture.png");
  try {
    // Read before the capture overlay or Lisa raises its own window. Do not
    // call AX at all unless explicitly requested for this capture.
    const context = includeContext
      ? await (dependencies.context ?? readCaptureContext)().catch(() => ({
          status: "unavailable" as const,
        }))
      : undefined;
    const capture =
      dependencies.capture ??
      ((args: string[]) =>
        new Promise<void>((resolve, reject) => {
          const child = spawn("/usr/sbin/screencapture", args);
          // Do not report screen/window metadata via command diagnostics.
          child.stderr.resume();
          child.on("error", () => reject(new Error("screen capture unavailable")));
          child.on("close", (code) =>
            code === 0 ? resolve() : reject(new Error("screen capture failed")),
          );
        }));
    await capture(buildScreencaptureArgs(mode, outPath));
    let bytes: Buffer;
    try {
      const stat = await fsp.stat(outPath);
      if (!stat.size) return null;
      if (stat.size > 14 * 1024 * 1024) throw new Error("screenshot exceeds attachment size limit");
      bytes = await fsp.readFile(outPath);
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code === "ENOENT") return null;
      throw error;
    }
    return {
      name: `screenshot-${stamp}.png`,
      mediaType: "image/png",
      data: bytes.toString("base64"),
      ...(context ? { context } : {}),
    };
  } finally {
    await fsp.rm(temp, { recursive: true, force: true }).catch(() => {});
  }
}
