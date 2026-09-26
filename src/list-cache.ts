import { createHash, randomUUID } from 'node:crypto';
import { mkdir, readFile, rename, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { configDir } from './config.js';
import type { SavedQuery, Ticket } from './providers/types.js';

export interface CacheEntry<T> { version: 1; fetchedAt: number; value: T }
export type CacheSource = 'memory' | 'disk' | 'network' | 'stale';
export interface CacheResult<T> { value: T; source: CacheSource }

/** Reports whether a cached value is a normalized ticket list. */
export function isTicketList(value: unknown): value is Ticket[] {
  return Array.isArray(value) && value.every(item => item && typeof item.id === 'string' && typeof item.provider === 'string' && typeof item.title === 'string' && ['Bug', 'User Story', 'Unsupported'].includes(item.type) && typeof item.typeLabel === 'string' && typeof item.status === 'string' && (item.priority === undefined || (item.priority && typeof item.priority.id === 'string' && typeof item.priority.name === 'string')));
}

/** Reports whether a cached value is a normalized saved-query list. */
export function isSavedQueryList(value: unknown): value is SavedQuery[] {
  return Array.isArray(value) && value.every(item => item && typeof item.id === 'string' && typeof item.name === 'string');
}

/** Promotes newly assigned tickets while preserving known-ticket order. */
export function orderAssignedTickets(previous: Ticket[] | undefined, fresh: Ticket[]): Ticket[] {
  if (!previous) return fresh;
  /** Builds a provider-qualified identity for ordering comparisons. */
  const key = (ticket: Ticket) => `${ticket.provider}:${ticket.id}`;
  const known = new Set(previous.map(key));
  const latest = new Map(fresh.map(ticket => [key(ticket), ticket]));
  const newlyAssigned = fresh.filter(ticket => !known.has(key(ticket)));
  const stillAssigned = previous.map(ticket => latest.get(key(ticket))).filter((ticket): ticket is Ticket => ticket !== undefined);
  return [...newlyAssigned, ...stillAssigned];
}

/** Returns IDs that appear in the refreshed assignment list for the first time. */
export function newlyAssignedTicketIds(previous: Ticket[] | undefined, fresh: Ticket[]): Set<string> {
  if (!previous) return new Set();
  const known = new Set(previous.map(ticket => `${ticket.provider}:${ticket.id}`));
  return new Set(fresh.filter(ticket => !known.has(`${ticket.provider}:${ticket.id}`)).map(ticket => ticket.id));
}

export class ListCache<T extends unknown[]> {
  private readonly values = new Map<string, CacheEntry<T>>();
  /** Creates a namespaced memory-and-disk list cache. */
  constructor(
    private readonly namespace: string,
    private readonly ttlMs: number,
    private readonly valid: (value: unknown) => value is T,
    private readonly root = join(configDir, 'cache'),
    private readonly now: () => number = Date.now
  ) {
    if (!Number.isFinite(ttlMs) || ttlMs <= 0) throw new Error('Cache TTL must be positive.');
  }
  /** Derives an opaque disk path for a cache key. */
  private path(key: string): string {
    const digest = createHash('sha256').update(JSON.stringify([this.namespace, key])).digest('hex');
    return join(this.root, `${digest}.json`);
  }
  /** Reports whether a cache entry is still inside its TTL. */
  private fresh(entry: CacheEntry<T>): boolean {
    const age = this.now() - entry.fetchedAt;
    return age >= 0 && age < this.ttlMs;
  }
  /** Reads and validates one cache entry from disk. */
  private async read(key: string): Promise<CacheEntry<T> | undefined> {
    try {
      const entry = JSON.parse(await readFile(this.path(key), 'utf8')) as Partial<CacheEntry<T>>;
      if (entry.version === 1 && typeof entry.fetchedAt === 'number' && this.valid(entry.value)) return entry as CacheEntry<T>;
    } catch {}
    return undefined;
  }
  /** Atomically writes one cache entry to disk. */
  private async write(key: string, entry: CacheEntry<T>): Promise<void> {
    await mkdir(this.root, { recursive: true, mode: 0o700 });
    const destination = this.path(key);
    const temp = `${destination}.${randomUUID()}.tmp`;
    await writeFile(temp, JSON.stringify(entry), { mode: 0o600, flag: 'wx' });
    await rename(temp, destination);
  }
  /** Returns cached data regardless of freshness without invoking a loader. */
  async peek(key: string): Promise<Omit<CacheEntry<T>, 'version'> | undefined> {
    const entry = this.values.get(key) ?? await this.read(key);
    return entry ? { fetchedAt: entry.fetchedAt, value: entry.value } : undefined;
  }
  /** Loads a list from memory, disk, or the source and reports its origin. */
  async getWithMetadata(key: string, load: () => Promise<T>, refresh = false): Promise<CacheResult<T>> {
    let stale: CacheEntry<T> | undefined;
    if (!refresh) {
      const memory = this.values.get(key);
      if (memory && this.fresh(memory)) return { value: memory.value, source: 'memory' };
      const disk = await this.read(key);
      if (disk && this.fresh(disk)) { this.values.set(key, disk); return { value: disk.value, source: 'disk' }; }
      stale = memory ?? disk;
    }
    let value: T;
    try { value = await load(); }
    catch (error) {
      if (stale) {
        this.values.set(key, stale);
        return { value: stale.value, source: 'stale' };
      }
      throw error;
    }
    if (!this.valid(value)) throw new Error('Invalid list response.');
    const entry: CacheEntry<T> = { version: 1, fetchedAt: this.now(), value };
    this.values.set(key, entry);
    try { await this.write(key, entry); }
    catch { console.warn('Could not save the OPAI list cache; this session will still use it.'); }
    return { value, source: 'network' };
  }
  /** Loads a list through the cache and returns only its value. */
  async get(key: string, load: () => Promise<T>, refresh = false): Promise<T> {
    return (await this.getWithMetadata(key, load, refresh)).value;
  }
}
