# LISA v0.27.1 — cloud inference recovery

LISA Cloud can use Gemini 2.5 Flash with the existing free allowance. Previously this model fell into the unknown-model premium tier, which would reject an account with no purchased credits even when its free allowance remained.

- Add exact-model Gemini Flash pricing and bump the pricing audit version. Flash-Lite, image, audio, preview, and unknown variants keep their previous conservative handling.
- Meter thinking tokens as output and cached prompt tokens separately, avoiding omitted reasoning cost and duplicate input charges.
- Accept `GEMINI_API_KEY` in the deployment helper, including Secret Manager mode.

Rates were verified against [Google's pricing](https://ai.google.dev/gemini-api/docs/pricing#gemini-2.5-flash), and usage semantics against [UsageMetadata](https://ai.google.dev/api/generate-content#UsageMetadata). No provider credentials are included in this release. The iOS binary does not change; its existing disclosure flow reads the active AI recipients from the server.

This release does not imply App Store submission or approval. See [the execution record](EXECUTION_PERSONAL_ASSISTANT_2026-09-27.md) for the live rollout and remaining review gates.
