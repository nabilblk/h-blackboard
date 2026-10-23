/** Shared read model subscriptions. A shell can replace the transport without
 * changing React. One read per key, bounded retry, and invalidation after writes.
 * These observations are never used to grant execution authority. */
type Listener<T> = { value(value: T): void; error(error: Error): void };
type Entry<T> = {
  load: () => Promise<T>;
  listeners: Set<Listener<T>>;
  next: number;
  data?: T;
  hasData: boolean;
  pending?: Promise<T>;
  failures: number;
  generation: number;
  fingerprint?: string;
};
export class Observations {
  private entries = new Map<string, Entry<unknown>>();
  private timer?: ReturnType<typeof setTimeout>;
  private active = 0;
  private get<T>(key: string, load: () => Promise<T>) {
    let entry = this.entries.get(key);
    if (!entry) {
      entry = {
        load,
        listeners: new Set(),
        next: 0,
        hasData: false,
        failures: 0,
        generation: 0,
      };
      this.entries.set(key, entry);
    }
    entry.load = load;
    return entry as Entry<T>;
  }
  subscribe<T>(
    key: string,
    load: () => Promise<T>,
    value: (v: T) => void,
    error: (e: Error) => void = () => {},
  ) {
    const entry = this.get(key, load),
      listener = { value, error };
    entry.listeners.add(listener);
    if (entry.hasData) value(entry.data as T);
    this.schedule();
    return () => {
      entry.listeners.delete(listener);
      if (!entry.listeners.size && !entry.pending) this.entries.delete(key);
      if (![...this.entries.values()].some((e) => e.listeners.size)) {
        clearTimeout(this.timer);
        this.timer = undefined;
      }
    };
  }
  invalidate(prefix = "") {
    for (const [key, entry] of this.entries)
      if (key.startsWith(prefix)) {
        entry.generation++;
        entry.next = 0;
      }
    this.schedule();
  }
  private fetch<T>(entry: Entry<T>): Promise<T> {
    if (entry.pending) return entry.pending;
    const generation = entry.generation;
    this.active++;
    entry.pending = Promise.resolve()
      .then(entry.load)
      .then((value) => {
        if (generation === entry.generation) {
          const fingerprint = JSON.stringify(value);
          const recovered = entry.failures > 0;
          entry.hasData = true;
          entry.data = value;
          entry.failures = 0;
          entry.next = Date.now() + 2500;
          if (recovered || entry.fingerprint !== fingerprint) {
            entry.fingerprint = fingerprint;
            for (const listener of entry.listeners) {
              try {
                listener.value(value);
              } catch {
                /* One view must not poison shared reads. */
              }
            }
          }
        }
        return value;
      })
      .catch((failure) => {
        if (generation !== entry.generation) throw failure;
        entry.failures++;
        entry.next =
          Date.now() + Math.min(30000, 2500 * 2 ** Math.min(4, entry.failures));
        const error =
          failure instanceof Error
            ? failure
            : new Error("Observation unavailable");
        for (const listener of entry.listeners) {
          try {
            listener.error(error);
          } catch {
            /* Isolate view errors. */
          }
        }
        throw error;
      })
      .finally(() => {
        entry.pending = undefined;
        this.active--;
        if (!entry.listeners.size)
          for (const [key, current] of this.entries)
            if (current === entry) this.entries.delete(key);
        this.schedule();
      });
    return entry.pending;
  }
  private schedule() {
    if (this.timer || ![...this.entries.values()].some((e) => e.listeners.size))
      return;
    this.timer = setTimeout(() => {
      this.timer = undefined;
      for (const entry of this.entries.values()) {
        if (this.active >= 4) break;
        if (entry.listeners.size && !entry.pending && entry.next <= Date.now())
          void this.fetch(entry).catch(() => {});
      }
      this.schedule();
    }, 250);
  }
}
const stores = new WeakMap<object, Observations>();
export function observations(client: object): Observations {
  let store = stores.get(client);
  if (!store) {
    store = new Observations();
    stores.set(client, store);
  }
  return store;
}
