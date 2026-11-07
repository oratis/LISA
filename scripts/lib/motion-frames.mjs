import sharp from "sharp";
import assert from "node:assert/strict";
function subjects(data, width, height) {
  const seen = new Uint8Array(width * height);
  const queue = new Int32Array(width * height);
  const found = [];
  for (let p = 0; p < seen.length; p++) {
    if (seen[p] || data[p * 4 + 3] < 100) continue;
    let count = 1,
      head = 0,
      left = width,
      top = height,
      right = 0,
      bottom = 0;
    queue[0] = p;
    seen[p] = 1;
    while (head < count) {
      const q = queue[head++],
        x = q % width,
        y = Math.floor(q / width);
      left = Math.min(left, x);
      right = Math.max(right, x);
      top = Math.min(top, y);
      bottom = Math.max(bottom, y);
      for (const r of [
        x > 0 ? q - 1 : -1,
        x < width - 1 ? q + 1 : -1,
        y > 0 ? q - width : -1,
        y < height - 1 ? q + width : -1,
      ]) {
        if (r >= 0 && !seen[r] && data[r * 4 + 3] >= 100) {
          seen[r] = 1;
          queue[count++] = r;
        }
      }
    }
    if (count > 10000) found.push({ left, top, right, bottom, pixels: count });
  }
  assert.equal(found.length, 9, "Expected exactly nine large connected subjects");
  found.sort((a, b) => a.top - b.top);
  const ordered = [];
  for (let r = 0; r < 3; r++)
    ordered.push(...found.slice(r * 3, r * 3 + 3).sort((a, b) => a.left - b.left));
  return ordered.map((b) => {
    let sum = 0,
      weight = 0;
    // Lower 30% avoids following the moving hands/book in the standing poses.
    for (let y = Math.round(b.top + 0.7 * (b.bottom - b.top)); y <= b.bottom; y++) {
      for (let x = b.left; x <= b.right; x++) {
        const a = data[(y * width + x) * 4 + 3];
        if (a >= 100) {
          sum += x * a;
          weight += a;
        }
      }
    }
    return { ...b, anchorX: sum / weight };
  });
}

export async function register(input, size, fill) {
  const { data, info } = await sharp(input)
    .ensureAlpha()
    .raw()
    .toBuffer({ resolveWithObject: true });
  const boxes = subjects(data, info.width, info.height);
  const heights = boxes.map((b) => b.bottom - b.top + 1).sort((a, b) => a - b);
  const widestHalf = Math.max(
    ...boxes.map((b) => Math.max(b.anchorX - b.left + 4, b.right - b.anchorX + 4)),
  );
  const scale = Math.min(
    (size * fill) / heights[4],
    (size * 0.46) / widestHalf,
    (size * 0.9) / (heights[8] + 8),
  );
  const raws = [];

  for (const box of boxes) {
    const rect = {
      left: Math.max(0, box.left - 4),
      top: Math.max(0, box.top - 4),
      width: 0,
      height: 0,
    };
    rect.width = Math.min(info.width, box.right + 5) - rect.left;
    rect.height = Math.min(info.height, box.bottom + 5) - rect.top;
    const resized = await sharp(input)
      .extract(rect)
      .resize(Math.round(rect.width * scale), Math.round(rect.height * scale))
      .png()
      .toBuffer();
    const left = Math.round(size / 2 - (box.anchorX - rect.left) * scale);
    const top = Math.round(size * 0.94 - (box.bottom - rect.top) * scale);
    const raw = await sharp({
      create: { width: size, height: size, channels: 4, background: transparent },
    })
      .composite([{ input: resized, left, top }])
      .raw()
      .toBuffer();
    raws.push(raw);
  }

  return raws;
}
const transparent = { r: 0, g: 0, b: 0, alpha: 0 };
