import { describe, test } from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { homeScope } from "../paths.js";
import {
  MAX_ROOM_ITEMS,
  placeRoomItem,
  readRoomDecor,
  removeRoomItem,
  resetRoomDecor,
  setRoomLighting,
  setRoomTheme,
} from "./store.js";
import { roomDecorateTool } from "../tools/room_decorate.js";

describe("room decor store and tool (Phase 4)", () => {
  test("persists theme, lighting, and bounded props isolated per Lisa home", async () => {
    const homeA = await fs.mkdtemp(path.join(os.tmpdir(), "lisa-room-a-"));
    const homeB = await fs.mkdtemp(path.join(os.tmpdir(), "lisa-room-b-"));
    try {
      const initial = await readRoomDecor(homeA);
      assert.equal(initial.theme, "studio");
      assert.equal(initial.lighting, "auto");
      assert.deepEqual(initial.items, []);

      await setRoomTheme("stargazer", homeA);
      await setRoomLighting("warm", homeA);
      const { item } = await placeRoomItem(
        {
          id: "brass-lamp",
          slot: "desk",
          label: "Brass desk lamp",
          emoji: "🪔",
          note: "Late-night reading",
        },
        homeA,
      );
      assert.equal(item.id, "brass-lamp");

      // Home B remains untouched.
      const stateB = await readRoomDecor(homeB);
      assert.equal(stateB.theme, "studio");
      assert.equal(stateB.items.length, 0);

      // Update in place preserves item count.
      await placeRoomItem({ id: "brass-lamp", slot: "window", label: "Warm window lamp" }, homeA);
      const afterUpdate = await readRoomDecor(homeA);
      assert.equal(afterUpdate.theme, "stargazer");
      assert.equal(afterUpdate.lighting, "warm");
      assert.equal(afterUpdate.items.length, 1);
      assert.equal(afterUpdate.items[0]?.slot, "window");

      // Enforces item cap.
      for (let i = 1; i < MAX_ROOM_ITEMS; i++) {
        await placeRoomItem({ id: `item-${i}`, slot: "shelf", label: `Book ${i}` }, homeA);
      }
      await assert.rejects(
        () => placeRoomItem({ id: "overflow", slot: "shelf", label: "Too many" }, homeA),
        /maximum/,
      );

      const removed = await removeRoomItem("brass-lamp", homeA);
      assert.equal(removed.removed, true);
      assert.equal(removed.state.items.length, MAX_ROOM_ITEMS - 1);

      const reset = await resetRoomDecor(homeA);
      assert.equal(reset.theme, "studio");
      assert.equal(reset.items.length, 0);
    } finally {
      await fs.rm(homeA, { recursive: true, force: true });
      await fs.rm(homeB, { recursive: true, force: true });
    }
  });

  test("room_decorate tool operates inside active homeScope and validates inputs", async () => {
    const home = await fs.mkdtemp(path.join(os.tmpdir(), "lisa-room-tool-"));
    const ctx = { cwd: home, signal: new AbortController().signal, log: () => {} };
    try {
      await homeScope.run(home, async () => {
        const resTheme = JSON.parse(
          await roomDecorateTool.execute({ action: "set_theme", theme: "botanical" }, ctx),
        );
        assert.equal(resTheme.theme, "botanical");

        const resLight = JSON.parse(
          await roomDecorateTool.execute({ action: "set_lighting", lighting: "dim" }, ctx),
        );
        assert.equal(resLight.lighting, "dim");

        const resPlace = JSON.parse(
          await roomDecorateTool.execute(
            { action: "place_item", id: "fern", slot: "window", label: "Potted fern", emoji: "🌿" },
            ctx,
          ),
        );
        assert.equal(resPlace.ok, true);
        assert.equal(resPlace.count, 1);

        const state = JSON.parse(await roomDecorateTool.execute({ action: "get" }, ctx));
        assert.equal(state.theme, "botanical");
        assert.equal(state.lighting, "dim");
        assert.equal(state.items[0]?.id, "fern");

        const resRm = JSON.parse(
          await roomDecorateTool.execute({ action: "remove_item", id: "fern" }, ctx),
        );
        assert.equal(resRm.removed, true);

        await assert.rejects(
          () => roomDecorateTool.execute({ action: "set_theme", theme: "invalid" }, ctx),
          /Invalid room theme/,
        );
      });
    } finally {
      await fs.rm(home, { recursive: true, force: true });
    }
  });
});
