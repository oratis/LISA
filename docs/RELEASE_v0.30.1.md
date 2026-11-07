# Lisa 0.30.1 — A clearer account and Pocket experience

The Mac account window now guides you through email and verification-code sign-in,
then switches to a dedicated account page with live connection status and a clear
next step for connecting Lisa Pocket.

- A refreshed native design with light and dark appearances, readable cards and layouts that adapt to smaller windows.
- Separate email, code and optional password steps, with resend countdowns, inline recovery and reliable keyboard focus.
- A three-step Pocket connection guide, prominent verification codes and clearer authorized-device controls.
- Sign-in attempts survive closing the window to check your inbox. Account validation and failed setup can recover without losing the next step.
- Cloud model account changes explicitly confirm interruptions; signing out closes phone access before applying the cleared account.
- Pairing v2 support and compatibility guidance for older Pocket versions, alongside the local-network/cloud relay connection flow.

This release also includes the reviewed main-branch updates since 0.30.0: cloud
account and billing hardening, hosted-account setup fixes, local retention fixes,
and the read-only Slack connection with task resume.

Install by replacing Lisa.app in Applications. If Lisa was already running, restart
its background service or restart the Mac to load the new embedded backend.
Existing account settings and approved devices are retained.

Physical iPhone Wi-Fi/cellular handoff remains pending; this Mac release does not
claim that unavailable-device test has been completed.
