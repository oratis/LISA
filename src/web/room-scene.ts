import { readFileSync } from "node:fs";

const seated = JSON.parse(
  readFileSync(new URL("./assets/visuals/soft-ink-room-v2/manifest.json", import.meta.url), "utf8"),
);

/** Scale around the pose's contact point so smaller figures stay on furniture. */
export const ROOM_CHARACTER_SCALE = 0.86;

/** Room-space anchors refer to the unscaled background, never the viewport.
 * A character's contact point (hips or soles) is pinned to one of these.
 * The same background pixels are reused as foreground furniture masks.
 */
export const ROOM_GEOMETRY = {
  room: {
    seat: [71.3, 61.8],
    feetFloor: 74,
    floor: [49.5, 87],
    window: [51, 72.5],
    chairFront:
      "polygon(69.6% 64%,70.7% 61.9%,76.5% 59.4%,80.2% 59.8%,82.7% 62.5%,81.9% 69.8%,79.7% 72.3%,72% 73%,69.6% 68.3%)",
    plantFront:
      "polygon(75.1% 61%,79.9% 56.8%,85% 56.2%,89.8% 58.8%,91.1% 63%,95% 65.4%,95.8% 76.6%,89.2% 82.2%,79.4% 82%,75.9% 75.9%,76% 68.1%)",
  },
  room2: {
    seat: [79.7, 68.2],
    feetFloor: 84,
    floor: [49.5, 87.5],
    window: [49, 72],
    chairFront:
      "polygon(86.8% 48.4%,89% 57%,88.8% 65.8%,85.8% 74.7%,83.8% 79.2%,82.9% 78.3%,86% 66%,87% 57.4%)",
    plantFront:
      "polygon(86.1% 86%,87.2% 80%,91.2% 80.1%,96.5% 83.9%,96% 93.8%,85.7% 94.3%,83.2% 90.2%)",
  },
} as const;

export type RoomPose =
  "stand" | "pjs" | "sleep" | "work" | "read" | "tea" | "listen" | "stretch" | "window";

/** Only actual activity signals select working/sleeping. Ambient activities
 * fill idle time and yield immediately to a real turn or dream. */
export function roomPose(state: {
  mood: string;
  dreaming: boolean;
  thinking: boolean;
  activity: string | null;
  tod: string | null;
}): RoomPose {
  if (state.dreaming) return "sleep";
  if (state.thinking) return "work";
  if (/sleep|nap/.test(state.mood)) return "sleep";
  if (/reading/.test(state.mood)) return "read";
  if (/working|studying|research|typing|writing|gaming|watching/.test(state.mood)) return "work";
  if (/drinking|tea|coffee/.test(state.mood)) return "tea";
  if (state.mood === "stretching") return "stretch";
  if (state.mood === "listening-music") return "listen";
  if (state.activity && ["read", "tea", "listen", "stretch", "window"].includes(state.activity)) {
    return state.activity as RoomPose;
  }
  return state.tod === "night" ? "pjs" : "stand";
}

export const ROOM_SCENE_JS = `var ROOM_CHARACTER_SCALE = ${ROOM_CHARACTER_SCALE};\nvar ROOM_GEOMETRY = ${JSON.stringify(ROOM_GEOMETRY)};\nvar ROOM_SEATED = ${JSON.stringify(seated)};\nvar roomPose = ${roomPose.toString()};`;
