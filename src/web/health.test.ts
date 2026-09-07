import { test, describe } from "node:test";
import assert from "node:assert/strict";
import {
  DEFAULT_WATCHDOG_LAG_MS,
  EventLoopMonitor,
  healthPayload,
  packageVersion,
  publicHealthPayload,
  watchdogThresholdFromEnv,
  type LagHistogram,
} from "./health.js";

const NS = 1e6;

/** A histogram we script: p50/p99/max in ms, reset() clears to zero. */
function fakeHistogram(): LagHistogram & {
  set(p50: number, p99: number, max: number): void;
  enabled: number;
} {
  let p50 = 0;
  let p99 = 0;
  let max = 0;
  let count = 0;
  return {
    enabled: 0,
    set(a, b, c) {
      p50 = a;
      p99 = b;
      max = c;
      count = 250;
    },
    percentile(p) {
      return (p >= 99 ? p99 : p50) * NS;
    },
    get max() {
      return max * NS;
    },
    get count() {
      return count;
    },
    reset() {
      p50 = p99 = max = 0;
      count = 0;
    },
    enable() {
      this.enabled++;
      return true;
    },
    disable() {
      return true;
    },
  };
}

interface Harness {
  h: ReturnType<typeof fakeHistogram>;
  m: EventLoopMonitor;
  warns: string[];
  errors: string[];
  exits: number[];
  clock: { t: number };
}

function harness(over: Partial<ConstructorParameters<typeof EventLoopMonitor>[0]> = {}): Harness {
  const h = fakeHistogram();
  const warns: string[] = [];
  const errors: string[] = [];
  const exits: number[] = [];
  const clock = { t: 1_000_000 };
  const m = new EventLoopMonitor({
    histogram: h,
    windowMs: 5_000,
    now: () => clock.t,
    warn: (s) => warns.push(s),
    error: (s) => errors.push(s),
    exit: (c) => exits.push(c),
    ...over,
  });
  return { h, m, warns, errors, exits, clock };
}

/** Advance one 5 s window with the given lag and close it. */
function window(x: Harness, p50: number, p99: number, max: number) {
  x.clock.t += 5_000;
  x.h.set(p50, p99, max);
  return x.m.tick();
}

describe("event loop monitor — readout", () => {
  test("a window snapshot converts ns → ms and the histogram is reset after each readout", () => {
    const x = harness();
    const snap = window(x, 1.5, 12, 40);
    assert.deepEqual(
      { p50: snap.p50, p99: snap.p99, max: snap.max },
      { p50: 1.5, p99: 12, max: 40 },
    );
    assert.equal(x.h.count, 0, "reset after readout");
    assert.deepEqual(x.m.latest(), snap);
  });

  test("an empty window (no samples) reads as zero lag, not NaN", () => {
    const x = harness();
    x.clock.t += 5_000;
    const snap = x.m.tick();
    assert.deepEqual([snap.p50, snap.p99, snap.max, snap.samples], [0, 0, 0, 0]);
    assert.equal(x.m.healthy(), true);
  });

  test("lastMinute() keeps the worst reading of the last 60 s so a stall that ended is still visible", () => {
    const x = harness();
    window(x, 1, 2, 3);
    window(x, 1, 6_000, 8_000); // the stall
    for (let i = 0; i < 5; i++) window(x, 1, 2, 3); // 25 s of calm
    assert.equal(x.m.latest()!.p99, 2);
    assert.deepEqual(x.m.lastMinute(), { p99: 6_000, max: 8_000 });
    // …and it ages out after a minute.
    for (let i = 0; i < 8; i++) window(x, 1, 2, 3);
    assert.deepEqual(x.m.lastMinute(), { p99: 2, max: 3 });
  });
});

describe("event loop monitor — lag WARNING", () => {
  test("p99 above 1 s warns once, then is rate-limited to one per minute", () => {
    const x = harness();
    window(x, 1, 1_500, 2_000);
    assert.equal(x.warns.length, 1);
    assert.match(x.warns[0]!, /p99=1500ms max=2000ms/);
    for (let i = 0; i < 10; i++) window(x, 1, 1_500, 2_000); // 50 s later, still lagging
    assert.equal(x.warns.length, 1, "suppressed inside the minute");
    for (let i = 0; i < 3; i++) window(x, 1, 1_500, 2_000); // crosses the minute
    assert.equal(x.warns.length, 2);
    assert.equal(x.m.healthy(), false);
  });

  test("p99 at or under 1 s never warns", () => {
    const x = harness();
    window(x, 5, 1_000, 3_000);
    assert.equal(x.warns.length, 0);
    assert.equal(x.m.healthy(), true);
  });
});

describe("event loop monitor — self-watchdog", () => {
  test("exits(1) with a sampling hint after p99 stays above the threshold for 60 s", () => {
    const x = harness({ watchdogMs: 5_000, watchdogForMs: 60_000 });
    for (let i = 0; i < 12; i++) {
      window(x, 10, 6_000, 9_000);
      if (i < 11) assert.equal(x.exits.length, 0, `window ${i}: not yet`);
    }
    assert.deepEqual(x.exits, [1]);
    assert.equal(x.errors.length, 1);
    assert.match(x.errors[0]!, /stayed above 5000ms for 60s/);
    assert.match(x.errors[0]!, /sample \d+ 5/);
    assert.match(x.errors[0]!, /LISA_WATCHDOG_LAG_MS=0 disables/);
    // A further window must not exit twice.
    window(x, 10, 6_000, 9_000);
    assert.deepEqual(x.exits, [1]);
  });

  test("one good window resets the streak", () => {
    const x = harness({ watchdogMs: 5_000, watchdogForMs: 60_000 });
    for (let i = 0; i < 11; i++) window(x, 10, 6_000, 9_000);
    window(x, 1, 50, 80); // recovered
    for (let i = 0; i < 11; i++) window(x, 10, 6_000, 9_000);
    assert.deepEqual(x.exits, [], "two separate 55 s streaks never add up to 60 s");
    window(x, 10, 6_000, 9_000);
    assert.deepEqual(x.exits, [1]);
  });

  test("threshold 0 disables the watchdog entirely (warnings still fire)", () => {
    const x = harness({ watchdogMs: 0 });
    assert.equal(x.m.watchdogEnabled, false);
    for (let i = 0; i < 40; i++) window(x, 10, 60_000, 90_000);
    assert.deepEqual(x.exits, []);
    assert.ok(x.warns.length >= 1);
  });

  test("LISA_WATCHDOG_LAG_MS parsing: unset → default, 0 → off, garbage → default", () => {
    assert.equal(watchdogThresholdFromEnv({}), DEFAULT_WATCHDOG_LAG_MS);
    assert.equal(watchdogThresholdFromEnv({ LISA_WATCHDOG_LAG_MS: "0" }), 0);
    assert.equal(watchdogThresholdFromEnv({ LISA_WATCHDOG_LAG_MS: "2500" }), 2500);
    assert.equal(watchdogThresholdFromEnv({ LISA_WATCHDOG_LAG_MS: "-1" }), DEFAULT_WATCHDOG_LAG_MS);
    assert.equal(
      watchdogThresholdFromEnv({ LISA_WATCHDOG_LAG_MS: "soon" }),
      DEFAULT_WATCHDOG_LAG_MS,
    );
  });
});

describe("event loop monitor — lifecycle", () => {
  test("start() enables the histogram and is idempotent; stop() clears the timer", () => {
    const x = harness();
    x.m.start();
    x.m.start();
    assert.equal(x.h.enabled, 1);
    x.m.stop();
    x.m.stop();
  });

  test("a real monitor does not keep the process alive (timer is unref'd)", () => {
    // If this held the loop, the node:test runner for this file would hang at
    // exit; the assertion is the file finishing. Also exercise the real
    // histogram path once for a sanity readout.
    const m = new EventLoopMonitor().start();
    const snap = m.tick();
    assert.ok(snap.p99 >= 0);
    m.stop();
  });
});

describe("health payload", () => {
  test("has the contract fields, computed from memory only", () => {
    const x = harness();
    window(x, 1.25, 3.75, 9.5);
    const p = healthPayload(x.m, { tenants: 2, pending_turns: 1, sessions: 3 }, "mac", 5000);
    assert.equal(p.ok, true);
    assert.equal(p.version, packageVersion());
    assert.notEqual(p.version, "unknown");
    assert.ok(p.uptime_s >= 0);
    assert.deepEqual(p.event_loop_lag_ms, { p50: 1.3, p99: 3.8, max: 9.5 });
    assert.deepEqual(p.event_loop_lag_1m_ms, { p99: 3.8, max: 9.5 });
    assert.ok(p.heap_used_mb > 0 && p.rss_mb > 0);
    assert.deepEqual([p.tenants, p.pending_turns, p.sessions], [2, 1, 3]);
    assert.equal(p.edition, "mac");
    assert.equal(p.watchdog_lag_ms, 5000);
  });

  test("ok flips to false while the last window is over the warn line", () => {
    const x = harness();
    window(x, 1, 4_000, 5_000);
    assert.equal(
      healthPayload(x.m, { tenants: 0, pending_turns: 0, sessions: 0 }, "cloud", 0).ok,
      false,
    );
  });
});

describe("the unauthenticated health payload (hosted edition)", () => {
  // /health runs before the auth gate so `lisa doctor --probe` works without
  // credentials. On a Mac that is the machine's owner; on the hosted edition
  // the same endpoint faces the public internet, where tenants / sessions /
  // pending_turns are live usage metrics and heap / RSS / uptime make restart
  // and load patterns observable. /healthz is the liveness probe, so nothing
  // operational needs the detail to be public.
  const full = () => {
    const x = harness();
    window(x, 1.25, 3.75, 9.5);
    return healthPayload(x.m, { tenants: 7, pending_turns: 2, sessions: 41 }, "cloud", 5000);
  };

  test("carries no usage or resource numbers", () => {
    const pub = publicHealthPayload(full());
    for (const field of [
      "tenants",
      "sessions",
      "pending_turns",
      "heap_used_mb",
      "rss_mb",
      "uptime_s",
      "version",
      "watchdog_lag_ms",
    ] as const) {
      assert.equal(pub[field], undefined, `${field} must not be served unauthenticated`);
    }
    // Belt and braces: no stringified value of a counter survives anywhere.
    const body = JSON.stringify(pub);
    for (const n of ["7", "41"]) {
      assert.ok(!body.includes(n), `counter ${n} leaked into ${body}`);
    }
  });

  test("still answers the question a public probe asks", () => {
    const pub = publicHealthPayload(full());
    assert.equal(pub.ok, true);
    assert.deepEqual(pub.event_loop_lag_ms, { p50: 1.3, p99: 3.8, max: 9.5 });
    assert.deepEqual(pub.event_loop_lag_1m_ms, { p99: 3.8, max: 9.5 });
    assert.equal(pub.edition, "cloud");
  });

  test("an unhealthy deployment still reports unhealthy", () => {
    const x = harness();
    window(x, 4000, 9000, 12000);
    const pub = publicHealthPayload(healthPayload(x.m, { tenants: 1, pending_turns: 0, sessions: 1 }, "cloud", 5000));
    assert.equal(pub.ok, false, "lagging must still be visible without a token");
  });
});
