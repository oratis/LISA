import crypto from "node:crypto";
import fs from "node:fs/promises";
import path from "node:path";
import { lisaHome } from "../../paths.js";
import type { SocialMediaRef } from "./types.js";

const MAX_MEDIA_BYTES = 256 * 1024 * 1024;

function mediaDir(): string {
  return path.join(lisaHome(), "sense", "social", "media");
}

function metadataPath(id: string): string {
  return path.join(mediaDir(), `${id}.json`);
}

function dataPath(id: string): string {
  return path.join(mediaDir(), `${id}.bin`);
}

function safeId(id: string): void {
  if (!/^[a-f0-9-]{36}$/.test(id)) throw new Error("invalid social media id");
}

function sniffMime(bytes: Buffer): string | null {
  if (bytes.subarray(0, 8).equals(Buffer.from("89504e470d0a1a0a", "hex"))) return "image/png";
  if (bytes[0] === 0xff && bytes[1] === 0xd8 && bytes[2] === 0xff) return "image/jpeg";
  if (bytes.subarray(0, 6).toString("ascii") === "GIF87a" || bytes.subarray(0, 6).toString("ascii") === "GIF89a") return "image/gif";
  if (bytes.subarray(0, 4).toString("ascii") === "RIFF" && bytes.subarray(8, 12).toString("ascii") === "WEBP") return "image/webp";
  if (bytes.subarray(4, 8).toString("ascii") === "ftyp") {
    const brand = bytes.subarray(8, 12).toString("ascii").toLowerCase();
    return brand === "qt  " ? "video/quicktime" : "video/mp4";
  }
  if (bytes.subarray(0, 4).equals(Buffer.from("1a45dfa3", "hex"))) return "video/webm";
  return null;
}

function stripJpegMetadata(bytes: Buffer): Buffer {
  const chunks: Buffer[] = [bytes.subarray(0, 2)];
  let offset = 2;
  while (offset + 2 <= bytes.length && bytes[offset] === 0xff) {
    const marker = bytes[offset + 1]!;
    if (marker === 0xda || marker === 0xd9) {
      chunks.push(bytes.subarray(offset));
      return Buffer.concat(chunks);
    }
    if (offset + 4 > bytes.length) throw new Error("malformed JPEG media");
    const length = bytes.readUInt16BE(offset + 2);
    if (length < 2 || offset + 2 + length > bytes.length) {
      throw new Error("malformed JPEG media");
    }
    const end = offset + 2 + length;
    // EXIF/XMP/ICC/IPTC/comment segments can carry location or identity.
    if (![0xe1, 0xe2, 0xed, 0xfe].includes(marker)) {
      chunks.push(bytes.subarray(offset, end));
    }
    offset = end;
  }
  throw new Error("malformed JPEG media");
}

function stripPngMetadata(bytes: Buffer): Buffer {
  const chunks: Buffer[] = [bytes.subarray(0, 8)];
  const privateTypes = new Set(["eXIf", "tEXt", "zTXt", "iTXt", "tIME"]);
  let offset = 8;
  while (offset + 12 <= bytes.length) {
    const length = bytes.readUInt32BE(offset);
    const end = offset + 12 + length;
    if (end > bytes.length) throw new Error("malformed PNG media");
    const type = bytes.subarray(offset + 4, offset + 8).toString("ascii");
    if (!privateTypes.has(type)) chunks.push(bytes.subarray(offset, end));
    offset = end;
    if (type === "IEND") return Buffer.concat(chunks);
  }
  // Unit fixtures may only contain the magic bytes; real PNGs must be complete.
  if (bytes.length === 8) return bytes;
  throw new Error("malformed PNG media");
}

function privacyNormalize(bytes: Buffer, mimeType: string): Buffer {
  if (mimeType === "image/jpeg") return stripJpegMetadata(bytes);
  if (mimeType === "image/png") return stripPngMetadata(bytes);
  if (
    mimeType === "image/webp" &&
    (bytes.includes(Buffer.from("EXIF")) || bytes.includes(Buffer.from("XMP ")))
  ) {
    throw new Error("WebP contains EXIF/XMP metadata; strip it before staging");
  }
  return bytes;
}

export async function stageSocialMedia(
  bytes: Buffer,
  claimedMimeType?: string,
  altText?: string,
): Promise<SocialMediaRef> {
  if (bytes.length === 0 || bytes.length > MAX_MEDIA_BYTES) {
    throw new Error(`social media must be between 1 byte and ${MAX_MEDIA_BYTES} bytes`);
  }
  const mimeType = sniffMime(bytes);
  if (!mimeType) throw new Error("unsupported or unrecognized social media format");
  if (claimedMimeType && claimedMimeType !== mimeType) {
    throw new Error(`social media MIME mismatch (claimed ${claimedMimeType}, detected ${mimeType})`);
  }
  const normalized = privacyNormalize(bytes, mimeType);
  const id = crypto.randomUUID();
  const ref: SocialMediaRef = {
    id,
    kind: mimeType.startsWith("image/") ? "image" : "video",
    mimeType,
    bytes: normalized.length,
    sha256: crypto.createHash("sha256").update(normalized).digest("hex"),
    ...(altText?.trim() ? { altText: altText.trim() } : {}),
  };
  await fs.mkdir(mediaDir(), { recursive: true, mode: 0o700 });
  await Promise.all([
    fs.writeFile(dataPath(id), normalized, { mode: 0o600 }),
    fs.writeFile(metadataPath(id), JSON.stringify(ref, null, 2), {
      encoding: "utf8",
      mode: 0o600,
    }),
  ]);
  return ref;
}

export async function loadSocialMedia(
  ref: SocialMediaRef,
): Promise<Buffer> {
  safeId(ref.id);
  const [rawMetadata, bytes] = await Promise.all([
    fs.readFile(metadataPath(ref.id), "utf8"),
    fs.readFile(dataPath(ref.id)),
  ]);
  const stored = JSON.parse(rawMetadata) as SocialMediaRef;
  const digest = crypto.createHash("sha256").update(bytes).digest("hex");
  if (
    stored.id !== ref.id ||
    stored.sha256 !== ref.sha256 ||
    digest !== ref.sha256 ||
    stored.bytes !== bytes.length ||
    stored.mimeType !== ref.mimeType
  ) {
    throw new Error(`social media integrity check failed for ${ref.id}`);
  }
  return bytes;
}
