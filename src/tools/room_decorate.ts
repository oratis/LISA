/**
 * Builtin tool `room_decorate` (Room Phase 4 — docs/PLAN_ROOM_v1.0.md).
 *
 * Lets Lisa curate her own living space (`<lisaHome>/soul/room.json`) by
 * selecting a room theme, setting ambient lighting, and placing or removing
 * small props. Confined strictly to Lisa's own home (Warden SELF_TOOLS).
 */
import type { ToolDefinition } from "../types.js";
import {
  MAX_ROOM_ITEMS,
  ROOM_LIGHTING,
  ROOM_SLOTS,
  ROOM_THEMES,
  placeRoomItem,
  readRoomDecor,
  removeRoomItem,
  resetRoomDecor,
  setRoomLighting,
  setRoomTheme,
  type RoomLighting,
  type RoomSlot,
  type RoomTheme,
} from "../room/store.js";

export const roomDecorateTool: ToolDefinition<Record<string, unknown>> = {
  name: "room_decorate",
  description:
    "View or customize Lisa's own room decor (<lisaHome>/soul/room.json): choose a room theme, adjust ambient lighting, or place/remove personal props (max 12).",
  inputSchema: {
    type: "object",
    properties: {
      action: {
        type: "string",
        enum: ["get", "set_theme", "set_lighting", "place_item", "remove_item", "reset"],
        description: "Decoration action to perform.",
      },
      theme: {
        type: "string",
        enum: [...ROOM_THEMES],
        description: "Room theme (required for action=set_theme).",
      },
      lighting: {
        type: "string",
        enum: [...ROOM_LIGHTING],
        description: "Ambient lighting preset (required for action=set_lighting).",
      },
      id: {
        type: "string",
        description:
          "Optional item id for place_item (update in place) or required for remove_item.",
      },
      slot: {
        type: "string",
        enum: [...ROOM_SLOTS],
        description: "Room slot where the item sits (required for action=place_item).",
      },
      label: {
        type: "string",
        description:
          "Short display label for the item (required for action=place_item, max 64 chars).",
      },
      emoji: {
        type: "string",
        description: "Optional small icon/emoji for the item.",
      },
      note: {
        type: "string",
        description: "Optional short note about why this item is here (max 200 chars).",
      },
    },
    required: ["action"],
  },
  async execute(input): Promise<string> {
    const action = typeof input.action === "string" ? input.action : "";
    switch (action) {
      case "get": {
        const state = await readRoomDecor();
        return JSON.stringify(state, null, 2);
      }
      case "set_theme": {
        const state = await setRoomTheme(input.theme as RoomTheme);
        return JSON.stringify({ ok: true, theme: state.theme, updatedAt: state.updatedAt });
      }
      case "set_lighting": {
        const state = await setRoomLighting(input.lighting as RoomLighting);
        return JSON.stringify({ ok: true, lighting: state.lighting, updatedAt: state.updatedAt });
      }
      case "place_item": {
        const { state, item } = await placeRoomItem({
          id: typeof input.id === "string" ? input.id : undefined,
          slot: input.slot as RoomSlot,
          label: typeof input.label === "string" ? input.label : "",
          emoji: typeof input.emoji === "string" ? input.emoji : undefined,
          note: typeof input.note === "string" ? input.note : undefined,
        });
        return JSON.stringify({
          ok: true,
          item,
          count: state.items.length,
          maxItems: MAX_ROOM_ITEMS,
        });
      }
      case "remove_item": {
        const id = typeof input.id === "string" ? input.id.trim() : "";
        if (!id) throw new Error("id is required for remove_item.");
        const { state, removed } = await removeRoomItem(id);
        return JSON.stringify({ ok: true, removed, remaining: state.items.length });
      }
      case "reset": {
        const state = await resetRoomDecor();
        return JSON.stringify({ ok: true, state });
      }
      default:
        throw new Error(
          `Unknown room_decorate action "${action}". Valid: get, set_theme, set_lighting, place_item, remove_item, reset.`,
        );
    }
  },
};
