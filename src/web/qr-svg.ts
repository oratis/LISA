/**
 * Render a scannable QR code as an inline SVG string, reusing the QR encoder
 * bundled inside `qrcode-terminal` (vendor/QRCode) — no extra dependency. Used by
 * the web "Pair phone" modal so a phone can scan the `lisa-pair://` link instead
 * of copy-pasting it. (The CLI renders the same data as a terminal QR; the Mac
 * app via CoreImage — this is the browser equivalent.)
 */
import { createRequire } from "node:module";

const require = createRequire(import.meta.url);

interface QRCodeInstance {
  addData(data: string): void;
  make(): void;
  getModuleCount(): number;
  isDark(row: number, col: number): boolean;
}
type QRCodeCtor = new (typeNumber: number, errorCorrectLevel: number) => QRCodeInstance;

// qrcode-terminal vendors a CommonJS QR encoder with no type declarations; load
// it via require so TS doesn't need a .d.ts for the deep subpath.
const QRCode = require("qrcode-terminal/vendor/QRCode") as QRCodeCtor;
const QRErrorCorrectLevel = require(
  "qrcode-terminal/vendor/QRCode/QRErrorCorrectLevel",
) as { L: number; M: number; Q: number; H: number };

/**
 * Encode `data` as a QR and return a square SVG (black modules on white, with a
 * quiet-zone margin). `size` is the rendered pixel size; the viewBox is in module
 * units so it stays crisp at any size. Error-correction level M (matches the Mac
 * app) tolerates some camera noise.
 */
export function qrSvg(data: string, opts: { size?: number; margin?: number } = {}): string {
  const qr = new QRCode(-1, QRErrorCorrectLevel.M);
  qr.addData(data);
  qr.make();
  const count = qr.getModuleCount();
  const margin = opts.margin ?? 4; // quiet zone (modules) — scanners need ≥4
  const total = count + margin * 2;
  const size = opts.size ?? 240;

  let rects = "";
  for (let row = 0; row < count; row++) {
    for (let col = 0; col < count; col++) {
      if (qr.isDark(row, col)) {
        rects += `<rect x="${col + margin}" y="${row + margin}" width="1" height="1"/>`;
      }
    }
  }
  return (
    `<svg xmlns="http://www.w3.org/2000/svg" width="${size}" height="${size}" ` +
    `viewBox="0 0 ${total} ${total}" shape-rendering="crispEdges" role="img" ` +
    `aria-label="Pairing QR code"><rect width="${total}" height="${total}" fill="#fff"/>` +
    `<g fill="#000">${rects}</g></svg>`
  );
}
