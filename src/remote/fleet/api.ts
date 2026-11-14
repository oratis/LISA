import type { RemoteHost } from "../host.js";
import path from "node:path";
import { FleetHostService } from "./host-service.js";
import { FleetController } from "./controller.js";
import { LocalClaude } from "./claude.js";
import {
  digest,
  FleetError,
  HOST_API,
  HOST_ID,
  requiredText,
  uuid,
  type FleetPeer,
} from "./types.js";
import { selectSecretBackend } from "../../warden/secrets-open.js";
import { KeychainSecretStore } from "../../warden/secrets-keychain.js";
import { EncryptedFileSecretStore, localKeyFile } from "../../warden/secrets-file.js";
import { loadControlPolicy } from "../../control/policy.js";

export class FleetApi {
  readonly host: FleetHostService;
  readonly controller: FleetController;
  constructor(home: string, port: number) {
    this.host = new FleetHostService(home, new LocalClaude(home, port));
    // The controller private key must never resolve through a model-facing secret:// handle.
    const dir = path.join(home, "fleet");
    const secrets =
      selectSecretBackend({ home }) === "keychain"
        ? new KeychainSecretStore({
            service: "ai.lisa.fleet." + digest(path.resolve(home)).slice(0, 12),
            indexFile: path.join(dir, "identity.index.json"),
          })
        : new EncryptedFileSecretStore({
            backend: "file",
            scope: "fleet-controller",
            file: path.join(dir, "identity.enc.json"),
            keys: localKeyFile(path.join(dir, "identity.key")),
          });
    this.controller = new FleetController(home, secrets);
  }
  peer(peer: FleetPeer, route: string, method: string, body: Record<string, unknown>) {
    const effective = { ...peer, control: peer.control && loadControlPolicy().remoteControl };
    return method === "GET"
      ? this.host.read(effective, route)
      : this.host.mutate(effective, route, body);
  }
  async owner(link: RemoteHost, route: string, method: string, body: Record<string, unknown>) {
    if (method === "GET" && route === "/api/fleet/hosts") {
      const directory = await this.controller.list();
      const localId = link.status().hostId;
      return { ...directory, hosts: directory.hosts.filter((h) => h.id !== localId) };
    }
    if (method === "GET" && route === "/api/fleet/local")
      return {
        link: link.status(),
        workspaces: this.host.workspaces(),
        runs: this.host.ownerRuns(),
        shares: this.host.ownerShares(
          link.status().hostId ?? "",
          link.status().devices.flatMap((d) => {
            const viewer = link.pocketDevice(d.id);
            return viewer ? [viewer] : [];
          }),
        ),
      };
    if (method !== "POST") throw new FleetError(405, "method_not_allowed");
    switch (route) {
      case "/api/fleet/shares": {
        const viewer = link.pocketDevice(String(body.deviceId));
        if (!viewer) throw new FleetError(403, "secure_pocket_required");
        if (typeof body.enabled !== "boolean") throw new FleetError(400, "invalid_share");
        return this.host.share(viewer, uuid(body.runId), body.enabled);
      }
      case "/api/fleet/workspaces":
        return this.host.register(body.name, body.directory);
      case "/api/fleet/local-stop":
        return this.host.ownerStop(uuid(body.runId), body.confirmUnknown === true);
      case "/api/fleet/grants": {
        if (
          !Array.isArray(body.workspaces) ||
          !body.workspaces.length ||
          body.workspaces.length > 32 ||
          typeof body.control !== "boolean"
        )
          throw new FleetError(400, "workspace_grant_required");
        const ids = body.workspaces.map(uuid);
        if (!ids.every((id) => this.host.workspaces().some((w) => w.id === id)))
          throw new FleetError(400, "workspace_not_found");
        const code = requiredText(body.code, 40);
        try {
          link.approve(String(body.deviceId), code, { workspaces: ids, control: body.control });
        } catch (err) {
          if (err instanceof Error && err.message === "pairing_expired")
            throw new FleetError(409, "pairing_expired");
          throw err;
        }
        return { approved: true };
      }
    }
    const id = String(body.hostId);
    if (!HOST_ID.test(id)) throw new FleetError(400, "invalid_host_id");
    if (route === "/api/fleet/pair")
      return this.controller.pair(
        id,
        body.code === undefined ? undefined : requiredText(body.code, 40),
      );
    if (route === "/api/fleet/forget") {
      await this.controller.forget(id);
      return { forgotten: true };
    }
    if (route === "/api/fleet/request") {
      const payload = body.payload;
      if (
        payload !== undefined &&
        (!payload || typeof payload !== "object" || Array.isArray(payload))
      )
        throw new FleetError(400, "invalid_payload");
      const reply = await this.controller.request(String(body.scope), id, {
        method: String(body.method),
        route: HOST_API + String(body.path),
        body: payload as Record<string, unknown> | undefined,
      });
      if (reply.status !== 200)
        throw new FleetError(
          reply.status,
          String(reply.data?.error || "remote_error").slice(0, 120),
        );
      return reply.data;
    }
    throw new FleetError(404, "route_not_found");
  }
}
