# Room character integration

The previous room dimmed only its background at night and positioned square
pose cells without a registered furniture contact. Lisa appeared brighter than
the room, floated in front of the chair and slid between unrelated poses.

This revision uses four new transparent seated illustrations: resting, reading,
working with a laptop and drinking tea. Their hip coordinates attach to each
room's cushion. Standing and window poses attach at the soles. Near armrests,
the hanging-chair rim and foreground plants reuse clipped pixels from the
original room art, so the character is correctly behind them. The room,
character, contact shadows and foreground share one time-of-day filter.

Breathing scales around the support point. Pose changes fade at the destination
instead of sliding a seated person across the room. Real work and dreaming
interrupt ambient activities. Latest-request handling prevents a slow image
from restoring an older pose, and failed loads retain the last placed figure.
Reduced-motion preferences disable animation, transitions and camera motion.

## Artwork and delivery

- Generator: built-in ImageGen, transparent output, two passes (pose generation
  followed by spacing refinement). No CLI/API fallback.
- Prompts: [prompts.txt](prompts.txt).
- Master: [seated-poses-master.png](seated-poses-master.png).
- Delivery: `src/web/assets/visuals/soft-ink-room-v2/` (four WebP cutouts and
  the contact/aspect manifest, approximately 143 KiB of image data).
- Rebuild: `node scripts/build-room-scene-assets.mjs`. This extracts fixed
  quadrants, trims transparent padding and encodes WebP; no artwork retouching.
- Scene registration and state policy: `src/web/room-scene.ts`.
- Renderer: `src/web/room.ts`.

## Verification

Build, client type check, scoped ESLint, formatting and 12 relevant tests pass.
Browser inspection covers both rooms, sleeping/reading/working/tea/standing,
day/dusk/night, narrow and square windows. Local native preview uses the
existing signed v0.28.1 app and a separate backend copy containing only the
room patch and its assets. The original startup command is backed up; the
signed app bundle, global CLI package and user data are preserved.

This is a local room preview, not a new public release. The motion is subtle
breathing, blink/presence beats and state transitions; it is not a skeletal
walking or furniture-interaction animation system.

[Night preview](room-night-preview.png).
