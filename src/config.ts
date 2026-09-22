import { readFile } from 'node:fs/promises';
import { homedir } from 'node:os';
import { join, resolve } from 'node:path';
export const configDir = join(homedir(), '.config', 'opai');
export interface Config { openproject: { url: string; instanceId: string; bugTypeId: number; userStoryTypeId: number }; cacheTtlHours?: number; defaultAgent?: 'claude' | 'codex'; cwd?: string; agents?: { claude?: string; codex?: string } }
export async function loadConfig(): Promise<Config> {
  let raw: unknown;
  try { raw = JSON.parse(await readFile(join(configDir, 'config.json'), 'utf8')); }
  catch { throw new Error(`Create ${join(configDir, 'config.json')} from config.example.json.`); }
  const c = raw as Partial<Config>;
  if (!c.openproject?.url || !c.openproject.instanceId || !Number.isInteger(c.openproject.bugTypeId) || !Number.isInteger(c.openproject.userStoryTypeId)) throw new Error('Config needs openproject.url, instanceId, bugTypeId, and userStoryTypeId. See config.example.json.');
  if (!/^https?:\/\//.test(c.openproject.url)) throw new Error('openproject.url must be an HTTP(S) URL.');
  if (new URL(c.openproject.url).hostname.endsWith('.example.com')) throw new Error(`Replace the sample openproject.url in ${join(configDir, 'config.json')} with your real OpenProject URL.`);
  if (!/^[a-zA-Z0-9_-]+$/.test(c.openproject.instanceId)) throw new Error('openproject.instanceId must contain only letters, digits, _ or -.');
  if (c.defaultAgent && !['claude','codex'].includes(c.defaultAgent)) throw new Error('defaultAgent must be claude or codex.');
  if (c.cacheTtlHours !== undefined && (typeof c.cacheTtlHours !== 'number' || !Number.isFinite(c.cacheTtlHours) || c.cacheTtlHours <= 0 || c.cacheTtlHours > 168)) throw new Error('cacheTtlHours must be greater than 0 and at most 168.');
  return { ...c, cwd: c.cwd ? resolve(c.cwd) : undefined } as Config;
}
