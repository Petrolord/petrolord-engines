// Byte-budgeted LRU cache of brick payloads with in-flight request
// de-duplication and scrub cancellation (plan of record: LRU cache and
// fetch-cancellation-on-scrub are correctness features from day 1, not
// hardening).
//
// The fetch layer is injected so jest can drive the cache without a
// network; the production fetcher does a direct authenticated GET against
// Supabase Storage — the owner-path RLS policies authorise the user's own
// bricks, and no Edge Function sits in the hot path.

/**
 * @typedef {(path: string, signal: AbortSignal) => Promise<ArrayBuffer>} BrickFetcher
 */

import { decodeBrickPayload } from './brickCodec';

export class BrickCache {
  /**
   * @param {BrickFetcher} fetcher
   * @param {{maxBytes?: number, dtype?: string, maxConcurrent?: number}} [opts]
   *   dtype: the volume's brick encoding (manifest.brick.dtype) — decode
   *   happens HERE so everything downstream of the cache is codec-blind
   *   (W4.4). maxConcurrent caps simultaneous fetches (excess calls
   *   queue FIFO); 0/undefined = unlimited, the pre-W4.4 behaviour.
   */
  constructor(fetcher, { maxBytes = 256 * 1024 * 1024, dtype = 'float32le', maxConcurrent = 0 } = {}) {
    this.fetcher = fetcher;
    this.maxBytes = maxBytes;
    this.dtype = dtype;
    this.maxConcurrent = maxConcurrent;
    this.bytes = 0;
    /** @type {Map<string, Float32Array>} insertion order = LRU order */
    this.cache = new Map();
    /** @type {Map<string, {promise: Promise<Float32Array>, controller: AbortController}>} */
    this.inflight = new Map();
    /** @type {Array<() => void>} fetch-slot waiters (concurrency cap) */
    this.slotQueue = [];
    this.activeFetches = 0;
    this.stats = { hits: 0, misses: 0, evictions: 0, aborts: 0 };
  }

  /** Wait for a fetch slot (queued case only — callers with a free slot
   *  must start their fetch SYNCHRONOUSLY, or an abort racing the start
   *  hands the fetcher an already-aborted signal it never listens to). */
  #queueSlot(signal) {
    return new Promise((resolve, reject) => {
      const waiter = () => {
        this.activeFetches += 1;
        resolve();
      };
      waiter.cancel = () => reject(new Error(ABORTED));
      this.slotQueue.push(waiter);
      if (signal) {
        signal.addEventListener('abort', () => {
          const i = this.slotQueue.indexOf(waiter);
          if (i >= 0) {
            this.slotQueue.splice(i, 1);
            waiter.cancel();
          }
        }, { once: true });
      }
    });
  }

  #releaseSlot() {
    this.activeFetches -= 1;
    const next = this.slotQueue.shift();
    if (next) next();
  }

  has(path) {
    return this.cache.has(path);
  }

  /** Fetch (or reuse) one brick; concurrent calls for a path share a request. */
  get(path) {
    const hit = this.cache.get(path);
    if (hit) {
      this.stats.hits += 1;
      this.cache.delete(path);          // refresh LRU position
      this.cache.set(path, hit);
      return Promise.resolve(hit);
    }
    const pending = this.inflight.get(path);
    if (pending) return pending.promise;

    this.stats.misses += 1;
    const controller = new AbortController();
    // settle handlers only clear THIS entry: an aborted fetch is removed
    // from `inflight` synchronously in cancelPendingExcept, and a newer
    // fetch for the same path may already occupy the slot by the time the
    // old promise settles.
    const entry = { promise: null, controller };
    const startFetch = () => this.fetcher(path, controller.signal)
      .finally(() => this.#releaseSlot());
    let fetchPromise;
    if (!this.maxConcurrent || this.activeFetches < this.maxConcurrent) {
      this.activeFetches += 1;
      fetchPromise = startFetch();               // synchronous start
    } else {
      fetchPromise = this.#queueSlot(controller.signal).then(() => {
        if (controller.signal.aborted) {         // aborted while queued
          this.#releaseSlot();
          throw new Error(ABORTED);
        }
        return startFetch();
      });
    }
    entry.promise = fetchPromise
      .then((buffer) => {
        const data = decodeBrickPayload(buffer, this.dtype);
        if (this.inflight.get(path) === entry) this.inflight.delete(path);
        this.#insert(path, data);
        return data;
      })
      .catch((err) => {
        if (this.inflight.get(path) === entry) this.inflight.delete(path);
        throw err;
      });
    this.inflight.set(path, entry);
    return entry.promise;
  }

  /**
   * Abort every in-flight fetch whose path is not in `keep` — called when
   * the user scrubs away before the old slice finished loading.
   *
   * Aborted entries leave `inflight` IMMEDIATELY: abort() rejects the old
   * promise on a later microtask, and a new slice request arriving in
   * that window must start a fresh fetch, not reuse a promise that is
   * doomed to reject with ABORTED (which callers treat as "user scrubbed
   * away" and silently drop — the new slice would never render).
   * @param {Set<string>} [keep]
   */
  cancelPendingExcept(keep = new Set()) {
    for (const [path, entry] of this.inflight) {
      if (!keep.has(path)) {
        this.inflight.delete(path);
        entry.controller.abort();
        this.stats.aborts += 1;
      }
    }
  }

  clear() {
    this.cancelPendingExcept();
    this.cache.clear();
    this.bytes = 0;
  }

  #insert(path, data) {
    this.bytes += data.byteLength;
    this.cache.set(path, data);
    for (const [oldPath, oldData] of this.cache) {
      if (this.bytes <= this.maxBytes || oldPath === path) break;
      this.cache.delete(oldPath);
      this.bytes -= oldData.byteLength;
      this.stats.evictions += 1;
    }
  }
}

/** Error message marker for aborted brick fetches. */
export const ABORTED = 'BRICK_FETCH_ABORTED';

/**
 * Production fetcher: authenticated GET straight to Supabase Storage.
 *
 * getToken may force a refresh; a 401/403 (expired JWT on a long job)
 * retries ONCE with getToken(true) so a region-grow that outlives the
 * access token recovers instead of failing and losing all progress.
 *
 * @param {{supabaseUrl: string, getToken: (force?: boolean) => Promise<string>, bucket?: string}} cfg
 * @returns {BrickFetcher}
 */
export function storageBrickFetcher({ supabaseUrl, getToken, bucket = 'seismic' }) {
  const url = (path) => `${supabaseUrl}/storage/v1/object/authenticated/${bucket}/${path}`;
  const attempt = async (path, signal, force) => {
    const token = await getToken(force);
    try {
      return await fetch(url(path), { headers: { Authorization: `Bearer ${token}` }, signal });
    } catch (err) {
      if (err.name === 'AbortError') throw new Error(ABORTED);
      throw err;
    }
  };
  return async (path, signal) => {
    let res = await attempt(path, signal, false);
    if (res.status === 401 || res.status === 403) {
      res = await attempt(path, signal, true);        // token likely expired; refresh once
    }
    if (!res.ok) throw new Error(`Brick fetch failed (${res.status}) for ${path}`);
    return res.arrayBuffer();
  };
}
