import fs from "node:fs/promises";
import { ConnectorError } from "./types.js";

export interface GoogleClient {
  clientId: string;
  clientSecret?: string;
}

// All desktop clients in the former test project share Luddi's consent screen.
export function isLuddiClient(clientId: string): boolean {
  return /^276223031533-[\w-]+\.apps\.googleusercontent\.com$/.test(clientId);
}

export async function googleClient(
  file = process.env.LISA_GOOGLE_CLIENT_FILE,
): Promise<GoogleClient> {
  let client: GoogleClient;
  if (file) {
    try {
      if ((await fs.stat(file)).size > 32_000) throw new Error();
      const { installed } = JSON.parse(await fs.readFile(file, "utf8")) as {
        installed?: { client_id?: string; client_secret?: string };
      };
      if (
        typeof installed?.client_id !== "string" ||
        (installed.client_secret !== undefined && typeof installed.client_secret !== "string")
      )
        throw new Error();
      client = { clientId: installed.client_id, clientSecret: installed.client_secret };
    } catch {
      throw new ConnectorError("google_desktop_client_required");
    }
  } else {
    client = {
      clientId: process.env.LISA_GOOGLE_CLIENT_ID ?? "",
      clientSecret: process.env.LISA_GOOGLE_CLIENT_SECRET,
    };
  }
  if (!/^[A-Za-z0-9._-]+\.apps\.googleusercontent\.com$/.test(client.clientId))
    throw new ConnectorError("google_client_not_configured");
  return client;
}

export async function gmailClient(): Promise<GoogleClient> {
  return googleClient(process.env.LISA_GMAIL_CLIENT_FILE || process.env.LISA_GOOGLE_CLIENT_FILE);
}
