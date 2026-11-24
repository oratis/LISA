/**
 * Room Phase 4 — Lisa's sovereign room decoration state (`<lisaHome>/soul/room.json`).
 *
 * Keeps theme, ambient lighting preference, and up to 12 placed room props so
 * Lisa can express herself in her own living space without fabricating false
 * activity signals (see docs/PLAN_ROOM_v1.0.md §5 Phase 4).
 */
import crypto from "node:crypto";
import fs from "node:fs/promises";
import path from "node:path";
import { pathExists } from "../fs-utils.js";
import { lisaHome } from "../paths.js";

export const ROOM_THEMES = ["studio", "rainy-window", "stargazer", "botanical"] as const;
export type RoomTheme = (typeof ROOM_THEMES)[number];

export const ROOM_LIGHTING = ["auto", "warm", "cool", "dim"] as const;
export type RoomLighting = (typeof ROOM_LIGHTING)[number];

export const ROOM_SLOTS = [
  "desk",
  "window",
  "shelf",
  "wall",
  "rug",
  "side-table",
  "bedside",
] as const;
export type RoomSlot = (typeof ROOM_SLOTS)[number];

export const MAX_ROOM_ITEMS = 12;
const MAX_LABEL_LEN = 64;
const MAX_NOTE_LEN = 200;
const MAX_EMOJI_LEN = 12;

export interface RoomDecorItem {
  id: string;
  slot: RoomSlot;
  label: string;
  emoji?: string;
  note?: string;
  placedAt: string;
}

export interface RoomDecorState {
  version: 1;
  theme: RoomTheme;
  lighting: RoomLighting;
  items: RoomDecorItem[];
  updatedAt: string;
}

export function defaultRoomDecorState(now = new Date()): RoomDecorState {
  return {
    version: 1,
    theme: "studio",
    lighting: "auto",
    items: [],
    updatedAt: now.toISOString(),
  };
}

export function roomDecorFile(home = lisaHome()): string {
  return path.join(home, "soul", "room.json");
}

function isRoomTheme(v: unknown): v is RoomTheme {
  return typeof v === "string" && (ROOM_THEMES as readonly string[]).includes(v);
}

function isRoomLighting(v: unknown): v is RoomLighting {
  return typeof v === "string" && (ROOM_LIGHTING as readonly string[]).includes(v);
}

function isRoomSlot(v: unknown): v is RoomSlot {
  return typeof v === "string" && (ROOM_SLOTS as readonly string[]).includes(v);
}

function sanitizeText(raw: string, maxLen: number): string {
  return raw
    .replace(/[\r\n\t]+/g, " ")
    .trim()
    .slice(0, maxLen);
}

function normalizeItem(raw: unknown): RoomDecorItem | null {
  if (!raw || typeof raw !== "object" || Array.isArray(raw)) return null;
  const r = raw as Record<string, unknown>;
  if (typeof r.id !== "string" || !/^[a-zA-Z0-9_-]{2,48}$/.test(r.id)) return null;
  if (!isRoomSlot(r.slot)) return null;
  if (typeof r.label !== "string") return null;
  const label = sanitizeText(r.label, MAX_LABEL_LEN);
  if (!label) return null;
  const item: RoomDecorItem = {
    id: r.id,
    slot: r.slot,
    label,
    placedAt: typeof r.placedAt === "string" ? r.placedAt : new Date().toISOString(),
  };
  if (typeof r.emoji === "string") {
    const emoji = sanitizeText(r.emoji, MAX_EMOJI_LEN);
    if (emoji) item.emoji = emoji;
  }
  if (typeof r.note === "string") {
    const note = sanitizeText(r.note, MAX_NOTE_LEN);
    if (note) item.note = note;
  }
  return item;
}

export async function readRoomDecor(home = lisaHome()): Promise<RoomDecorState> {
  const file = roomDecorFile(home);
  if (!(await pathExists(file))) return defaultRoomDecorState();
  try {
    const raw = JSON.parse(await fs.readFile(file, "utf8")) as Record<string, unknown>;
    const theme = isRoomTheme(raw.theme) ? raw.theme : "studio";
    const lighting = isRoomLighting(raw.lighting) ? raw.lighting : "auto";
    const items: RoomDecorItem[] = [];
    if (Array.isArray(raw.items)) {
      for (const entry of raw.items) {
        const normalized = normalizeItem(entry);
        if (normalized && !items.some((x) => x.id === normalized.id)) {
          items.push(normalized);
        }
        if (items.length >= MAX_ROOM_ITEMS) break;
      }
    }
    return {
      version: 1,
      theme,
      lighting,
      items,
      updatedAt: typeof raw.updatedAt === "string" ? raw.updatedAt : new Date().toISOString(),
    };
  } catch {
    return defaultRoomDecorState();
  }
}

async function writeRoomDecor(state: RoomDecorState, home = lisaHome()): Promise<void> {
  const file = roomDecorFile(home);
  const dir = path.dirname(file);
  await fs.mkdir(dir, { recursive: true, mode: 0o700 });
  const tmp = `${file}.${process.pid}.${crypto.randomBytes(4).toString("hex")}.tmp`;
  await fs.writeFile(tmp, JSON.stringify(state, null, 2) + "\n", { mode: 0o600 });
  await fs.rename(tmp, file);
}

export async function setRoomTheme(theme: RoomTheme, home = lisaHome()): Promise<RoomDecorState> {
  if (!isRoomTheme(theme)) {
    throw new Error(`Invalid room theme "${String(theme)}". Valid: ${ROOM_THEMES.join(", ")}`);
  }
  const state = await readRoomDecor(home);
  state.theme = theme;
  state.updatedAt = new Date().toISOString();
  await writeRoomDecor(state, home);
  return state;
}

export async function setRoomLighting(
  lighting: RoomLighting,
  home = lisaHome(),
): Promise<RoomDecorState> {
  if (!isRoomLighting(lighting)) {
    throw new Error(
      `Invalid room lighting "${String(lighting)}". Valid: ${ROOM_LIGHTING.join(", ")}`,
    );
  }
  const state = await readRoomDecor(home);
  state.lighting = lighting;
  state.updatedAt = new Date().toISOString();
  await writeRoomDecor(state, home);
  return state;
}

export async function placeRoomItem(
  input: { id?: string; slot: RoomSlot; label: string; emoji?: string; note?: string },
  home = lisaHome(),
): Promise<{ state: RoomDecorState; item: RoomDecorItem }> {
  if (!isRoomSlot(input.slot)) {
    throw new Error(`Invalid room slot "${String(input.slot)}". Valid: ${ROOM_SLOTS.join(", ")}`);
  }
  const label = sanitizeText(input.label ?? "", MAX_LABEL_LEN);
  if (!label) throw new Error("Room item label is required.");
  const state = await readRoomDecor(home);
  const id =
    input.id && /^[a-zA-Z0-9_-]{2,48}$/.test(input.id)
      ? input.id
      : `prop-${crypto.randomBytes(4).toString("hex")}`;
  const existingIndex = state.items.findIndex((x) => x.id === id);
  if (existingIndex === -1 && state.items.length >= MAX_ROOM_ITEMS) {
    throw new Error(`Room already has the maximum of ${MAX_ROOM_ITEMS} items. Remove one first.`);
  }
  const nowIso = new Date().toISOString();
  const item: RoomDecorItem = {
    id,
    slot: input.slot,
    label,
    ...(input.emoji ? { emoji: sanitizeText(input.emoji, MAX_EMOJI_LEN) } : {}),
    ...(input.note ? { note: sanitizeText(input.note, MAX_NOTE_LEN) } : {}),
    placedAt: nowIso,
  };
  if (existingIndex >= 0) {
    state.items[existingIndex] = item;
  } else {
    state.items.push(item);
  }
  state.updatedAt = nowIso;
  await writeRoomDecor(state, home);
  return { state, item };
}

export async function removeRoomItem(
  id: string,
  home = lisaHome(),
): Promise<{ state: RoomDecorState; removed: boolean }> {
  const state = await readRoomDecor(home);
  const before = state.items.length;
  state.items = state.items.filter((x) => x.id !== id);
  const removed = state.items.length < before;
  if (removed) {
    state.updatedAt = new Date().toISOString();
    await writeRoomDecor(state, home);
  }
  return { state, removed };
}

export async function resetRoomDecor(home = lisaHome()): Promise<RoomDecorState> {
  const state = defaultRoomDecorState();
  await writeRoomDecor(state, home);
  return state;
}
