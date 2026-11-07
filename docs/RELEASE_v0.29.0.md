# Lisa 0.29.0 — Pocket connects to your Mac anywhere

Sign in to the same LISA account on Mac and Lisa Pocket 1.3. In Pocket, choose your
Mac and compare the code shown on both devices. Approve on the Mac once, then Pocket
prefers your local network and falls back to the encrypted cloud relay when away.
No Tailscale installation, manual IP address or router port forwarding is needed.

Mac adds **Connect iPhone…** for approving and disconnecting phones. The Mac must
remain awake with Lisa running. Connections use end-to-end encryption; the relay
cannot read requests or responses. Interrupted actions are not automatically resent.

Existing QR and Cloud connections remain supported. Physical iPhone Wi-Fi/cellular
handoff testing is pending; automated route switching and deployed relay tests are
recorded in `docs/REMOTE_CONNECTIONS.md`.
