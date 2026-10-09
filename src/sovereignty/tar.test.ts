import assert from "node:assert/strict";
import { describe, test } from "node:test";
import {
  readTar,
  TarFormatError,
  tarFileHeader,
  tarPadding,
  tarTrailer,
  type TarEntryHeader,
} from "./tar.js";

const LIMITS = { maxFileBytes: 1024 * 1024, maxTotalBytes: 4 * 1024 * 1024, maxEntries: 100 };

function archive(files: { path: string; data: string | Buffer }[]): Buffer {
  const parts: Buffer[] = [];
  for (const f of files) {
    const data = Buffer.isBuffer(f.data) ? f.data : Buffer.from(f.data);
    parts.push(tarFileHeader(f.path, data.length, Date.now()), data, tarPadding(data.length));
  }
  parts.push(tarTrailer());
  return Buffer.concat(parts);
}

/** Re-type a single-block ustar header and fix its checksum. */
function retype(header: Buffer, typeflag: string): Buffer {
  const h = Buffer.from(header);
  h[156] = typeflag.charCodeAt(0);
  h.fill(0x20, 148, 156);
  let sum = 0;
  for (const b of h) sum += b;
  h.write(sum.toString(8).padStart(6, "0") + "\0 ", 148, "ascii");
  return h;
}

async function* chunks(buf: Buffer, size = 97): AsyncGenerator<Buffer> {
  for (let i = 0; i < buf.length; i += size) yield buf.subarray(i, i + size);
}

async function collect(buf: Buffer, limits = LIMITS) {
  const out: { header: TarEntryHeader; data: Buffer }[] = [];
  let cur: { header: TarEntryHeader; parts: Buffer[] } | null = null;
  await readTar(
    chunks(buf),
    {
      begin(header) {
        cur = { header, parts: [] };
      },
      data(chunk) {
        cur!.parts.push(Buffer.from(chunk));
      },
      end() {
        out.push({ header: cur!.header, data: Buffer.concat(cur!.parts) });
        cur = null;
      },
    },
    limits,
  );
  return out;
}

describe("tar writer/reader", () => {
  test("round-trips files, including a pax long path and an empty file", async () => {
    const long = `kb/wiki/${"a".repeat(60)}/${"b".repeat(70)}/${"c".repeat(120)}.md`;
    const files = [
      { path: "manifest.json", data: '{"x":1}' },
      { path: "soul/identity.md", data: "I am Lisa.\n".repeat(100) },
      { path: long, data: "deep" },
      { path: "memory/USER.md", data: "" },
    ];
    const got = await collect(archive(files));
    assert.deepEqual(
      got.map((g) => [g.header.path, g.data.toString()]),
      files.map((f) => [f.path, f.data]),
    );
  });

  for (const [flag, label] of [
    ["1", "hard link"],
    ["2", "symbolic link"],
    ["3", "character device"],
    ["4", "block device"],
    ["6", "FIFO"],
    ["L", "GNU long name"],
  ] as const) {
    test(`rejects a ${label} entry`, async () => {
      const header = retype(tarFileHeader("soul/evil", 0, 0), flag);
      const buf = Buffer.concat([header, tarTrailer()]);
      await assert.rejects(collect(buf), (e: Error) => {
        assert.ok(e instanceof TarFormatError);
        assert.match(e.message, new RegExp(label));
        return true;
      });
    });
  }

  test("rejects a corrupted header checksum", async () => {
    const buf = archive([{ path: "soul/x.md", data: "x" }]);
    buf[0] = "z".charCodeAt(0);
    await assert.rejects(collect(buf), /checksum/);
  });

  test("enforces per-file, total and entry-count limits", async () => {
    const big = archive([{ path: "soul/big.md", data: Buffer.alloc(5000, 0x61) }]);
    await assert.rejects(collect(big, { ...LIMITS, maxFileBytes: 4096 }), /file too large/);
    const many = archive([
      { path: "soul/a.md", data: Buffer.alloc(3000, 0x61) },
      { path: "soul/b.md", data: Buffer.alloc(3000, 0x61) },
    ]);
    await assert.rejects(collect(many, { ...LIMITS, maxTotalBytes: 5000 }), /too large/);
    await assert.rejects(collect(many, { ...LIMITS, maxEntries: 1 }), /too many/);
  });

  test("rejects a truncated archive", async () => {
    const buf = archive([{ path: "soul/x.md", data: "hello world" }]);
    await assert.rejects(collect(buf.subarray(0, 520)), /truncated/);
  });
});
