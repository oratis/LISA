// One isolated Mac runtime per OS process. No provider credentials are inherited.
import { startWebServer } from "../../../src/web/server.js";
await import("../../e2e/helpers/make-soul.js");
const server = await startWebServer({
  port: 0,
  host: "127.0.0.1",
  tools: [],
  model: "fixture",
  thinking: false,
  reflect: false,
  idleMinutes: 0,
  hooks: [],
});
process.send!((server.address() as { port: number }).port);
process.on("disconnect", () => {
  server.close(() => process.exit(0));
});
