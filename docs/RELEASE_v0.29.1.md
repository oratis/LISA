# Lisa 0.29.1 — Mac connection security and reliability

Update from 0.29.0 to receive the reviewed Mac connection fixes. Lisa Pocket 1.3
continues to work with this version; no new phone pairing is required for an already approved device.

- Reject cross-site and DNS-rebinding requests to Mac connection management, so a webpage cannot choose a relay or approve a phone.
- Keep large or slow responses from disconnecting the shared cloud connection.
- Separate LAN and cloud connection limits, and keep dismissed pairing requests dismissed.
- Allow normal differences between the phone and Mac clocks without interrupting requests.

The cloud relay is live. Pocket 1.3 is available in internal TestFlight and has been
submitted to App Store review. Physical iPhone Wi-Fi/cellular handoff testing remains
pending; the signed simulator passed real production WSS and LAN fallback/recovery tests.
