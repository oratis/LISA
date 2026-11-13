// The hosted edition with its in-process relay broker, in its own OS process. The edition
// is read from process.env on every request, so a cloud server cannot share a process with
// the Mac backend it relays to. The parent supplies the environment (LISA_EDITION=cloud,
// LISA_RELAY_ENABLED=1, a throwaway LISA_HOME) and stops the relay by killing this process.
import type { AddressInfo } from "node:net";
import { startWebServer } from "../../../src/web/server.js";
import { createEmailAccount } from "../../../src/web/accounts.js";
import { loadOrCreateSessionSecret, mintSession } from "../../../src/web/sessions-auth.js";

const server = await startWebServer({
  port: 0,
  host: "127.0.0.1",
  tools: [],
  model: "gemini-2.5-flash",
  thinking: false,
  reflect: false,
  idleMinutes: 0,
  hooks: [],
});
const secret = loadOrCreateSessionSecret();
const accounts: Record<string, { uid: string; token: string }> = {};
for (const name of ["alice", "bob"]) {
  const account = await createEmailAccount(`relay-${name}@example.com`, "test-password");
  accounts[name] = {
    uid: account.uid,
    token: mintSession(account.uid, secret, { sv: account.sessionVersion }),
  };
}
process.send!({ port: (server.address() as AddressInfo).port, accounts });
// Never outlive the test process.
process.on("disconnect", () => process.exit(0));
