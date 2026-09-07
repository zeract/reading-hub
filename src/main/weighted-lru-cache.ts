type CacheOptions<K, V> = {
  maxEntries: number;
  maxWeight: number;
  weight: (key: K, value: V) => number;
  expiresAt?: (value: V) => number;
};

/** Bounded retained cost, not an exact heap measurement. Values must not be
 * mutated after insertion; reads refresh recency without extending expiry. */
export class WeightedLruCache<K, V> {
  private readonly entries = new Map<K, { value: V; weight: number; expiresAt?: number }>();
  private retainedWeight = 0;

  constructor(private readonly options: CacheOptions<K, V>) {
    if (!Number.isSafeInteger(options.maxEntries) || options.maxEntries < 1
      || !Number.isSafeInteger(options.maxWeight) || options.maxWeight < 1) {
      throw new RangeError("Cache budgets must be positive safe integers.");
    }
  }

  get(key: K): V | undefined {
    this.pruneExpired();
    const entry = this.entries.get(key);
    if (!entry) return undefined;
    this.entries.delete(key);
    this.entries.set(key, entry);
    return entry.value;
  }

  set(key: K, value: V): void {
    this.pruneExpired();
    this.forget(key);
    const weight = this.options.weight(key, value);
    const expiresAt = this.options.expiresAt?.(value);
    // Oversized/expired replacements must not leave an older value behind.
    // The current caller can still use its result without retaining it.
    if (!Number.isSafeInteger(weight) || weight < 0 || weight > this.options.maxWeight
      || (expiresAt !== undefined && (!Number.isFinite(expiresAt) || expiresAt <= Date.now()))) return;
    // Make room before adding to avoid overflowing the accounting counter.
    while (this.entries.size >= this.options.maxEntries || this.retainedWeight > this.options.maxWeight - weight) {
      this.forget(this.entries.keys().next().value!);
    }
    this.entries.set(key, { value, weight, expiresAt });
    this.retainedWeight += weight;
  }

  private pruneExpired(): void {
    const now = Date.now();
    for (const [key, entry] of this.entries) {
      if (entry.expiresAt !== undefined && entry.expiresAt <= now) this.forget(key);
    }
  }

  private forget(key: K): void {
    const entry = this.entries.get(key);
    if (!entry) return;
    this.retainedWeight -= entry.weight;
    this.entries.delete(key);
  }
}
