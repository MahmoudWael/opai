import { randomUUID } from 'node:crypto';
import { mkdir, readFile, rename, writeFile } from 'node:fs/promises';
import { dirname, join } from 'node:path';
import { configDir } from './config.js';
import type { SavedQuery } from './providers/types.js';

export interface QueryPreference { pinned: boolean; lastOpenedAt?: string }
export type QueryPreferences = Record<string, QueryPreference>;
export type QuerySectionKind = 'pinned' | 'recent' | 'all';
export interface QuerySection { kind: QuerySectionKind; queries: SavedQuery[] }

/** Orders saved queries by pin, recency, and then name. */
export function orderedQueries(queries: SavedQuery[], preferences: QueryPreferences, provider: string): SavedQuery[] {
  return [...queries].sort((a, b) => {
    const left = preferences[`${provider}:${a.id}`];
    const right = preferences[`${provider}:${b.id}`];
    if (Boolean(left?.pinned) !== Boolean(right?.pinned)) return left?.pinned ? -1 : 1;
    const recent = Date.parse(right?.lastOpenedAt ?? '') - Date.parse(left?.lastOpenedAt ?? '');
    if (Number.isFinite(recent) && recent !== 0) return recent;
    if (left?.lastOpenedAt && !right?.lastOpenedAt) return -1;
    if (!left?.lastOpenedAt && right?.lastOpenedAt) return 1;
    return a.name.localeCompare(b.name);
  });
}

/** Groups saved queries into pinned, recent, and remaining sections. */
export function querySections(queries: SavedQuery[], preferences: QueryPreferences, provider: string): QuerySection[] {
  const sections: Record<QuerySectionKind, SavedQuery[]> = { pinned: [], recent: [], all: [] };
  for (const query of orderedQueries(queries, preferences, provider)) {
    const preference = preferences[`${provider}:${query.id}`];
    if (preference?.pinned) sections.pinned.push(query);
    else if (preference?.lastOpenedAt) sections.recent.push(query);
    else sections.all.push(query);
  }
  return (['pinned', 'recent', 'all'] as const)
    .filter(kind => sections[kind].length > 0)
    .map(kind => ({ kind, queries: sections[kind] }));
}

export class QueryPreferencesStore {
  /** Creates a saved-query preference store with an injectable clock. */
  constructor(readonly path = join(configDir, 'query-preferences.json'), private readonly now: () => Date = () => new Date()) {}
  /** Loads all saved-query preferences. */
  async all(): Promise<QueryPreferences> {
    try {
      const value: unknown = JSON.parse(await readFile(this.path, 'utf8'));
      if (!value || typeof value !== 'object' || Array.isArray(value)) throw new Error('Invalid query preferences.');
      return value as QueryPreferences;
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code === 'ENOENT') return {};
      throw error;
    }
  }
  /** Atomically persists saved-query preferences. */
  private async save(value: QueryPreferences): Promise<void> {
    await mkdir(dirname(this.path), { recursive: true, mode: 0o700 });
    const temp = `${this.path}.${randomUUID()}.tmp`;
    await writeFile(temp, JSON.stringify(value, null, 2) + '\n', { mode: 0o600, flag: 'wx' });
    await rename(temp, this.path);
  }
  /** Records when a saved query was opened while retaining its pin state. */
  async opened(provider: string, id: string): Promise<void> {
    const value = await this.all();
    const key = `${provider}:${id}`;
    value[key] = { pinned: Boolean(value[key]?.pinned), lastOpenedAt: this.now().toISOString() };
    await this.save(value);
  }
  /** Toggles and returns the local pin state for a saved query. */
  async togglePin(provider: string, id: string): Promise<boolean> {
    const value = await this.all();
    const key = `${provider}:${id}`;
    const pinned = !value[key]?.pinned;
    value[key] = { ...value[key], pinned };
    await this.save(value);
    return pinned;
  }
}
