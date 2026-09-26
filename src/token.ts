import { randomUUID } from 'node:crypto';
import { chmod, mkdir, readFile, rename, writeFile } from 'node:fs/promises';
import { dirname, join } from 'node:path';
import { configDir } from './config.js';

export const tokenPath = join(configDir, 'token');

/** Loads the API token from the environment or the private token file. */
export async function loadApiToken(path = tokenPath, environment = process.env.OPENPROJECT_API_TOKEN): Promise<string | undefined> {
  if (environment?.trim()) return environment.trim();
  try {
    const token = (await readFile(path, 'utf8')).trim();
    return token || undefined;
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === 'ENOENT') return undefined;
    throw new Error(`Could not read OPAI token file at ${path}.`);
  }
}

/** Atomically saves a non-empty API token with owner-only permissions. */
export async function saveApiToken(token: string, path = tokenPath): Promise<void> {
  if (!token.trim()) throw new Error('API token cannot be empty.');
  await mkdir(dirname(path), { recursive: true, mode: 0o700 });
  const temp = `${path}.${randomUUID()}.tmp`;
  await writeFile(temp, `${token.trim()}\n`, { mode: 0o600, flag: 'wx' });
  await chmod(temp, 0o600);
  await rename(temp, path);
}
