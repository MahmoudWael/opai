import { createHash, randomUUID } from 'node:crypto';
import { mkdir, readFile, rename, writeFile } from 'node:fs/promises';
import { dirname, join } from 'node:path';
import { configDir } from './config.js';

interface UpdateState {
  version: 1;
  lastCheckedAt: number;
  latestVersion?: string;
}

export interface UpdateNotice {
  currentVersion: string;
  latestVersion: string;
}

interface UpdateCheckerOptions {
  path?: string;
  intervalMs?: number;
  request?: typeof fetch;
  now?: () => number;
  timeoutMs?: number;
}

const registryUrl = 'https://registry.npmjs.org/%40mahmoudwael%2Fopai/latest';

function stableVersion(value: string): number[] | undefined {
  const match = value.match(/^(\d+)\.(\d+)\.(\d+)$/);
  return match ? match.slice(1).map(Number) : undefined;
}

export function isNewerVersion(latest: string, current: string): boolean {
  const left = stableVersion(latest);
  const right = stableVersion(current);
  if (!left || !right) return false;
  for (let index = 0; index < 3; index++) {
    if (left[index]! > right[index]!) return true;
    if (left[index]! < right[index]!) return false;
  }
  return false;
}

export class UpdateChecker {
  private readonly path: string;
  private readonly intervalMs: number;
  private readonly request: typeof fetch;
  private readonly now: () => number;
  private readonly timeoutMs: number;

  constructor(private readonly currentVersion: string, options: UpdateCheckerOptions = {}) {
    this.path = options.path ?? join(configDir, 'update-check.json');
    this.intervalMs = options.intervalMs ?? 7 * 86_400_000;
    this.request = options.request ?? fetch;
    this.now = options.now ?? Date.now;
    this.timeoutMs = options.timeoutMs ?? 3_000;
    if (!Number.isFinite(this.intervalMs) || this.intervalMs <= 0) throw new Error('Update-check interval must be positive.');
  }

  private async read(): Promise<UpdateState | undefined> {
    try {
      const value = JSON.parse(await readFile(this.path, 'utf8')) as Partial<UpdateState>;
      if (value.version === 1 && typeof value.lastCheckedAt === 'number' && (value.latestVersion === undefined || typeof value.latestVersion === 'string')) return value as UpdateState;
    } catch {}
    return undefined;
  }

  private async write(value: UpdateState): Promise<void> {
    const root = dirname(this.path);
    await mkdir(root, { recursive: true, mode: 0o700 });
    const temp = `${this.path}.${createHash('sha256').update(randomUUID()).digest('hex')}.tmp`;
    await writeFile(temp, JSON.stringify(value), { flag: 'wx', mode: 0o600 });
    await rename(temp, this.path);
  }

  private notice(state: UpdateState | undefined): UpdateNotice | undefined {
    return state?.latestVersion && isNewerVersion(state.latestVersion, this.currentVersion)
      ? { currentVersion: this.currentVersion, latestVersion: state.latestVersion }
      : undefined;
  }

  async check(): Promise<UpdateNotice | undefined> {
    const previous = await this.read();
    const now = this.now();
    if (previous && now - previous.lastCheckedAt >= 0 && now - previous.lastCheckedAt < this.intervalMs) return this.notice(previous);
    const next: UpdateState = { version: 1, lastCheckedAt: now, latestVersion: previous?.latestVersion };
    try {
      const response = await this.request(registryUrl, { method: 'GET', headers: { Accept: 'application/json' }, signal: AbortSignal.timeout(this.timeoutMs) });
      if (response.ok) {
        const body = await response.json() as { version?: unknown };
        if (typeof body.version === 'string' && stableVersion(body.version)) next.latestVersion = body.version;
      }
    } catch {}
    try { await this.write(next); } catch {}
    return this.notice(next);
  }
}
