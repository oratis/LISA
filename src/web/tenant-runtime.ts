/**
 * Bounded lifecycle registry for per-tenant in-memory runtime state.
 *
 * Entries are created single-flight, pinned while a request uses them, and
 * evicted by idle TTL then LRU. Pinned entries may temporarily exceed the
 * configured capacity; the next release/sweep brings the registry back under
 * the limit without allowing two live runtimes for one tenant.
 */
export interface TenantRuntimeOptions {
  ttlMs: number;
  maxEntries: number;
  now?: () => number;
}

export interface TenantRuntimeLease<T> {
  value: T;
  release(): void;
}

interface Entry<T> {
  value: T;
  lastAccessAt: number;
  pins: number;
}

export interface TenantRuntimeStats {
  entries: number;
  pinned: number;
  creating: number;
  evictions: number;
}

export function tenantRuntimeOptions(
  env: Record<string, string | undefined> = process.env,
): TenantRuntimeOptions {
  const ttlMinutes = Number(env.LISA_TENANT_RUNTIME_TTL_MIN);
  const maxEntries = Number(env.LISA_TENANT_RUNTIME_MAX);
  return {
    ttlMs: (Number.isFinite(ttlMinutes) && ttlMinutes > 0 ? ttlMinutes : 30) * 60_000,
    maxEntries:
      Number.isInteger(maxEntries) && maxEntries > 0
        ? maxEntries
        : 100,
  };
}

export class TenantRuntimeRegistry<T> {
  private readonly entries = new Map<string, Entry<T>>();
  private readonly creating = new Map<string, Promise<T>>();
  private readonly now: () => number;
  private evictions = 0;

  constructor(private readonly options: TenantRuntimeOptions) {
    if (!Number.isFinite(options.ttlMs) || options.ttlMs <= 0) {
      throw new Error("tenant runtime ttlMs must be positive");
    }
    if (!Number.isInteger(options.maxEntries) || options.maxEntries <= 0) {
      throw new Error("tenant runtime maxEntries must be a positive integer");
    }
    this.now = options.now ?? Date.now;
  }

  async acquire(key: string, create: () => Promise<T>): Promise<TenantRuntimeLease<T>> {
    this.sweep();
    let entry = this.entries.get(key);
    if (!entry) {
      let pending = this.creating.get(key);
      if (!pending) {
        pending = create();
        this.creating.set(key, pending);
      }
      try {
        const value = await pending;
        entry = this.entries.get(key);
        if (!entry) {
          entry = { value, lastAccessAt: this.now(), pins: 0 };
          this.entries.set(key, entry);
        }
      } finally {
        if (this.creating.get(key) === pending) this.creating.delete(key);
      }
    }

    entry.pins++;
    entry.lastAccessAt = this.now();
    let released = false;
    return {
      value: entry.value,
      release: () => {
        if (released) return;
        released = true;
        entry!.pins = Math.max(0, entry!.pins - 1);
        entry!.lastAccessAt = this.now();
        this.sweep();
      },
    };
  }

  peek(key: string): T | undefined {
    const entry = this.entries.get(key);
    if (!entry) return undefined;
    entry.lastAccessAt = this.now();
    return entry.value;
  }

  delete(key: string): boolean {
    this.creating.delete(key);
    return this.entries.delete(key);
  }

  sweep(): void {
    const now = this.now();
    for (const [key, entry] of this.entries) {
      if (entry.pins === 0 && now - entry.lastAccessAt >= this.options.ttlMs) {
        this.entries.delete(key);
        this.evictions++;
      }
    }
    if (this.entries.size <= this.options.maxEntries) return;
    const idle = [...this.entries.entries()]
      .filter(([, entry]) => entry.pins === 0)
      .sort((a, b) => a[1].lastAccessAt - b[1].lastAccessAt);
    for (const [key] of idle) {
      if (this.entries.size <= this.options.maxEntries) break;
      this.entries.delete(key);
      this.evictions++;
    }
  }

  stats(): TenantRuntimeStats {
    let pinned = 0;
    for (const entry of this.entries.values()) pinned += entry.pins > 0 ? 1 : 0;
    return {
      entries: this.entries.size,
      pinned,
      creating: this.creating.size,
      evictions: this.evictions,
    };
  }
}
