import crypto from "node:crypto";

/** v1 wire format shared with RemoteMacTransport.swift. No credentials in routing metadata. */
export const MAX_FRAME = 1024 * 1024;
export const MAX_BUFFER = 4 * MAX_FRAME;
export interface LinkIdentity {
  publicKey: string;
  privateKey: string;
}
export interface SealedFrame {
  seq: number;
  box: string;
}
export interface HostInfo {
  id: string;
  name: string;
  publicKey: string;
  online: boolean;
}
export function identity(): LinkIdentity {
  const pair = crypto.generateKeyPairSync("x25519");
  const jwk = pair.privateKey.export({ format: "jwk" });
  return {
    publicKey: Buffer.from(jwk.x!, "base64url").toString("base64"),
    privateKey: Buffer.from(jwk.d!, "base64url").toString("base64"),
  };
}
export function keyBytes(value: unknown): Buffer {
  if (typeof value !== "string" || !/^[A-Za-z0-9+/]{43}=$/.test(value))
    throw new Error("invalid_key");
  const bytes = Buffer.from(value, "base64");
  if (bytes.length !== 32) throw new Error("invalid_key");
  return bytes;
}
export function keyId(publicKey: string): string {
  return crypto.createHash("sha256").update(keyBytes(publicKey)).digest("hex").slice(0, 32);
}
export function verificationCode(hostKey: string, clientKey: string): string {
  return crypto
    .createHash("sha256")
    .update(Buffer.concat([keyBytes(hostKey), keyBytes(clientKey)]))
    .digest("hex")
    .slice(0, 12)
    .toUpperCase()
    .match(/.{4}/g)!
    .join(" ");
}

/** Separate directional keys + exact counters prevent reflection/reordering/replay. */
export class LinkCipher {
  private sendSeq = 0;
  private receiveSeq = 0;
  private readonly sendKey: Buffer;
  private readonly receiveKey: Buffer;
  private readonly sending: string;
  private readonly receiving: string;
  constructor(own: LinkIdentity, peerKey: string, salt: string, role: "host" | "client") {
    const privateKey = crypto.createPrivateKey({
      format: "jwk",
      key: {
        kty: "OKP",
        crv: "X25519",
        x: keyBytes(own.publicKey).toString("base64url"),
        d: keyBytes(own.privateKey).toString("base64url"),
      },
    });
    const publicKey = crypto.createPublicKey({
      format: "jwk",
      key: { kty: "OKP", crv: "X25519", x: keyBytes(peerKey).toString("base64url") },
    });
    const shared = crypto.diffieHellman({ privateKey, publicKey });
    const hostKey = role === "host" ? own.publicKey : peerKey;
    const clientKey = role === "client" ? own.publicKey : peerKey;
    const info = `lisa-link-v1|${keyId(hostKey)}|${keyId(clientKey)}`;
    const derive = (direction: string) =>
      Buffer.from(
        crypto.hkdfSync("sha256", shared, keyBytes(salt), Buffer.from(`${info}|${direction}`), 32),
      );
    this.sending = role === "host" ? "h2c" : "c2h";
    this.receiving = role === "host" ? "c2h" : "h2c";
    this.sendKey = derive(this.sending);
    this.receiveKey = derive(this.receiving);
  }
  seal(value: unknown): SealedFrame {
    const seq = this.sendSeq++;
    const iv = crypto.randomBytes(12);
    const cipher = crypto.createCipheriv("aes-256-gcm", this.sendKey, iv);
    cipher.setAAD(Buffer.from(`lisa-link-v1|${this.sending}|${seq}`));
    const data = Buffer.concat([cipher.update(JSON.stringify(value)), cipher.final()]);
    return { seq, box: Buffer.concat([iv, data, cipher.getAuthTag()]).toString("base64") };
  }
  open(frame: SealedFrame): Record<string, unknown> {
    if (
      frame.seq !== this.receiveSeq ||
      typeof frame.box !== "string" ||
      frame.box.length > MAX_FRAME
    )
      throw new Error("invalid_frame");
    const box = Buffer.from(frame.box, "base64");
    if (box.length < 28) throw new Error("invalid_frame");
    const decipher = crypto.createDecipheriv("aes-256-gcm", this.receiveKey, box.subarray(0, 12));
    decipher.setAAD(Buffer.from(`lisa-link-v1|${this.receiving}|${frame.seq}`));
    decipher.setAuthTag(box.subarray(-16));
    const value: unknown = JSON.parse(
      Buffer.concat([decipher.update(box.subarray(12, -16)), decipher.final()]).toString(),
    );
    if (!value || typeof value !== "object" || Array.isArray(value))
      throw new Error("invalid_frame");
    this.receiveSeq++;
    return value as Record<string, unknown>;
  }
}
