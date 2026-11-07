import { test } from "node:test";
import assert from "node:assert/strict";
import vm from "node:vm";
import { roomPose, ROOM_SCENE_JS } from "./room-scene.js";

const idle = { mood: "neutral", dreaming: false, thinking: false, activity: null, tod: "day" };

test("live work and dreaming interrupt ambient activities, including stale sleepy moods", () => {
  assert.equal(roomPose({ ...idle, activity: "tea", thinking: true }), "work");
  assert.equal(roomPose({ ...idle, mood: "sleepy", thinking: true }), "work");
  assert.equal(roomPose({ ...idle, thinking: true, dreaming: true }), "sleep");
});

test("reading and drinking use their own chair poses; only plain night idle uses pajamas", () => {
  assert.equal(roomPose({ ...idle, mood: "reading-book", tod: "night" }), "read");
  assert.equal(roomPose({ ...idle, mood: "drinking-coffee" }), "tea");
  assert.equal(roomPose({ ...idle, mood: "working-coding" }), "work");
  assert.equal(roomPose({ ...idle, mood: "napping" }), "sleep");
  assert.equal(roomPose({ ...idle, activity: "window", tod: "night" }), "window");
  assert.equal(roomPose({ ...idle, tod: "night" }), "pjs");
});

test("the script embedded in the room has the same state policy as the server module", () => {
  const context = vm.createContext({});
  vm.runInContext(ROOM_SCENE_JS, context);
  for (const mood of ["neutral", "reading-book", "working-research", "sleepy"]) {
    assert.equal(
      vm.runInContext(`roomPose(${JSON.stringify({ ...idle, mood })})`, context),
      roomPose({ ...idle, mood }),
    );
  }
});
