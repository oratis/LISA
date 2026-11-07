# Pocket ↔ Mac: cloud relay and automatic LAN connections

Production relay deployed on 2026-11-07 at `cloud.meetlisa.ai/api/relay/*`
(Worker version `62681223-d843-4da5-b773-6fe8fff4657a`). Requires Mac 0.29.0
and Pocket 1.3. The existing account service stays on Cloud Run.

## Connect

1. On the Mac, sign in to LISA. Open **Connect iPhone…** in the menu and enable
   phone connections if they are off. The first sign-in in the updated Mac app
   enables discovery, but does not authorize any phone.
2. In Pocket, sign in to the **same LISA account**. Open **Settings → Connect your Mac**
   and select the online Mac. No IP address, QR code or Tailscale installation is needed.
3. Compare the `XXXX XXXX XXXX` verification code on the phone and Mac. On the Mac,
   choose **Allow this device**, then confirm that the codes match.
4. Pocket remembers the Mac's public key. It prefers an authenticated LAN connection;
   if LAN is unavailable, it connects through the cloud relay. Settings shows the route.

The Mac must be awake with its backend running. This connects to the Mac's existing
LISA history, memory and tasks; it does not merge those with the independent Cloud
LISA. There is no offline task queue. Legacy QR/Tailscale connections remain available.

Use **Disconnect [device]** on the Mac to revoke a phone and immediately close its
live streams on both routes. **Turn off phone connections** closes the LAN listener
and cloud connection. Mac sign-out confirms this shutdown before clearing the account. Signing out in Pocket
removes its saved account-based Mac profile. Changing the Mac's account resets its
device keys and grants; devices must be approved again.

## Deployment

- Production relay lives in `deploy/relay-worker`: a Cloudflare Worker handles only
  `cloud.meetlisa.ai/api/relay/*`. Existing account/login/AI endpoints stay on Cloud Run.
  Deploy with `cd deploy/relay-worker && npm ci && npm run check && npm test && npm run deploy`.
- Each authenticated account deterministically routes to one Durable Object. Mac and
  Pocket sockets share that actor even across edge servers and Worker revisions.
  WebSocket attachments preserve routing during hibernation; no chat content or private
  device keys are stored. Existing sockets can close during a Worker update; clients reconnect.
- The Worker authenticates native Bearer sessions through the fixed account origin's
  `/api/auth/me` (no redirects), rechecks active sessions every 15 seconds, and closes
  them on expiry, deletion, or authentication-service failure. Each account allows
  80 sockets, 10 Macs, and 64 channels per Mac; messages are limited to 1 MiB.
- The in-process Node broker (`LISA_RELAY_ENABLED=1`) remains available for tests and
  explicitly single-process installations. It is **off by default in Cloud Run**.
  Cloud Run max-instance settings are soft limits and are not a production routing guarantee.
- Roll back the relay using Wrangler versions/rollback. Do not remove the Durable Object
  namespace or alter account-ID routing during rollback. There are no device keys to migrate.
- On the Mac, the existing account session is read from `LISA_MANAGED_SESSION` and
  `LISA_MANAGED_BASE`. Local consent, X25519 identity and grants live in
  `~/.lisa/remote-link.json` (atomic writes, mode 0600). The LAN listener exposes only
  `/link`, on a saved automatically chosen port; it never exposes the owner HTTP API.
  Permit LISA/Node local-network access in the OS firewall for automatic direct connections.

## Protocol and boundaries

The production Worker and local `src/remote/broker.ts` verify the account before each WebSocket upgrade and periodically
rechecks account validity/expiry. Discovery and forwarding are namespaced by authenticated
account, never by a caller-supplied uid. Account deletion closes its live relay sockets.
Only online hosts are listed; existing saved Mac profiles remain on the phone when offline.

The Mac registers its name and public X25519 key. Its ID is the first 16 bytes of
SHA-256(raw public key), lowercase hex. A client hello includes its persistent public key,
a random 32-byte salt, and a display name. The cloud sees these routing metadata, but no
private keys, authorization secrets, API paths, request bodies or response contents.
New authorization requests are accepted only through the authenticated cloud route.
Unknown LAN peers cannot create pairing prompts.

For `lisa-link-v1`, endpoints derive separate `c2h` and `h2c` keys using X25519 +
HKDF-SHA256 with `info = lisa-link-v1|hostID|clientID|direction`. AES-256-GCM envelopes
use `{seq, box}`, with standard base64 of `12-byte nonce || ciphertext || 16-byte tag`.
AAD is `lisa-link-v1|direction|seq`; receivers require the next exact counter. Public
keys and salt also use standard base64. The comparison code is the first six bytes of
SHA-256(host raw key || client raw key), uppercase hex grouped into fours.
This version uses persistent agreement keys and does not claim forward secrecy.
The comparison code is derived from both keys without a prior commitment, so it
defends first pairing against a passive relay only. An actively malicious relay (or an
interceptor of the account origin's TLS) that substitutes *both* keys can search for a
matching pair: about 2^24 key generations per side, minutes on one CPU core. Approved
devices and later connections are unaffected. A future protocol version should commit
to keys before revealing them, or compare a longer code.

The encrypted welcome proves possession of the pinned Mac key, reports authorization,
and gives a fresh server challenge. Authorized welcomes also carry LAN endpoints.
Only private IPv4 `/link` URLs are used; cloud credentials are never attached to LAN probes.
Authenticated LAN endpoints are cached and re-probed after network changes. A failed
LAN probe falls back to the cloud before any user request is sent.

Each encrypted request binds a UUID, a short expiry and the fresh server challenge.
One request is permitted per channel. Recent UUIDs reject duplicate dispatch across
routes. Responses contain encrypted headers, data chunks and an explicit end marker,
supporting both ordinary REST and incremental SSE. Cancellation closes the local request.
Responses are flow-controlled per channel: when the LAN socket or the shared relay uplink
backs up past 1 MiB, the Mac pauses the local response instead of buffering it. The Mac
caps LAN and relay channels separately (64 each). Request expiry tolerates five minutes
of phone/Mac clock skew; replay is bound to the per-channel challenge.
**After a user request is sent, it is never automatically retried on another route**:
the operation might already have run. Existing event subscribers can open a fresh stream.

The loopback forwarding hop carries a private, per-process marker. The main server
classifies it as a **remote device**, validates its current Mac-owned grant, and applies
the existing remote-control and local-owner restrictions. An arbitrary marker can only
downgrade a caller; it cannot grant localhost privileges. Client-supplied headers and
arbitrary outbound URLs are never forwarded. Connection management itself cannot be
invoked through the encrypted tunnel. On the Mac, `/api/remote/*` additionally requires a
loopback `Host` and refuses cross-site or foreign `Origin` requests, so a DNS-rebinding
page cannot select a relay or approve a device. A dismissed pairing request stays
dismissed for its 10-minute lifetime even while Pocket keeps polling.

## API additions

- Cloud `GET /api/relay/macs`: verified account session → `{hosts: [{id,name,publicKey,online}]}`.
- Cloud WebSocket `/api/relay/host`: outbound Mac registration and multiplexed ciphertext.
- Cloud WebSocket `/api/relay/client?host=ID`: one phone request/stream, same account only.
- Mac owner `GET /api/remote/status`: connection state, pending code comparisons, authorized devices.
- Mac owner `POST /api/remote/connect`: `{base?,session?}`; omitted values use the backend account config.
- Mac owner `POST /api/remote/approve`: `{id,code}`; a current pending request and exact code are required.
- Mac owner `POST /api/remote/revoke`: `{id}`; closes live connections and removes consent.
- Mac owner `POST /api/remote/disconnect`: `{}`; disables both listeners/routes.

## Validation

On 2026-11-07 the signed iOS simulator passed `RemoteMacLiveTests` against the
production Worker: Cloud relay → Local network → Cloud relay when LAN was blocked
→ Local network after recovery. This used real URLSession WebSockets, the actual
CryptoKit/Node protocol and a private-IP LAN endpoint under the app's ATS settings.
The test's transport disabled only this development Mac's unavailable proxy.
Physical Wi-Fi ↔ cellular handoff remains **not tested** (iPhone unavailable).


The Node integration tests boot the real Mac HTTP server and real WebSocket peers,
and separately boot the real Cloud account server. They cover account isolation,
expired/invalid sessions, explicit approval, cloud/LAN equivalence, SSE, cancellation,
revocation, replay rejection and loopback privilege preservation. Pocket tests cover
cross-language Node/CryptoKit ciphertext, LAN URL constraints, saved key pinning,
failed-LAN fallback, network-change reprobes and no mutation replay after uncertain delivery.

Release acceptance still requires real iPhone testing over Wi-Fi → cellular → Wi-Fi,
Mac sleep/wake, firewall denial and the deployed proxy. Local automated tests cannot
establish the availability or behavior of the production domain or an installed App Store build.

### Reproduce the production URLSession check

Use a dedicated test-account session in a mode-0600 file, then run from the repo root:

```sh
LISA_RELAY_TEST_SESSION_FILE=/protected/test-session node --import tsx scripts/remote-relay-fixture.ts
```

The disposable fixture publishes its public identity through the deployed relay and writes
`.tmp/release/live-fixture.json` (0600). Run `RemoteMacLiveTests` with
`TEST_RUNNER_LISA_LIVE_RELAY_FIXTURE` set to that file's absolute path. Simulator tests
must use `CODE_SIGNING_ALLOWED=YES CODE_SIGN_IDENTITY=-` so Keychain writes work.
The opt-in test disables the test session's proxy only; normal app sessions retain
system proxy settings. It verifies real production WSS, CryptoKit/Node encryption,
private-IP LAN/ATS, failed-LAN fallback, and LAN recovery after a network-change signal.
The fixture rejects LAN connections while keeping discovery hints, modelling an
unreachable LAN rather than shutting down the Mac. Stop the fixture after testing;
its temporary identity and grants are removed. Never commit the session or fixture JSON.
