import { readFile } from 'node:fs/promises';
import { homedir } from 'node:os';
import { join, resolve } from 'node:path';
import { parseConfiguredModels, type ConfiguredModels } from './models.js';
export const configDir = join(homedir(), '.config', 'opai');
export interface PromptTemplates { bug?: string; userStory?: string }
export interface Config { openproject: { url: string; instanceId: string; bugTypeId: number; userStoryTypeId: number; requestTimeoutSeconds?: number; promptTemplates?: PromptTemplates }; cacheTtlHours?: number; updateCheckDays?: number; defaultAgent?: 'claude' | 'codex'; cwd?: string; agents?: { claude?: string; codex?: string }; models?: ConfiguredModels }
/** Parses and validates configured ticket prompt templates. */
export function parsePromptTemplates(value: unknown): PromptTemplates | undefined {
  if (value === undefined) return undefined;
  if (!value || typeof value !== 'object' || Array.isArray(value)) throw new Error('openproject.promptTemplates must be an object.');
  const source = value as Record<string, unknown>;
  const result: PromptTemplates = {};
  for (const kind of ['bug', 'userStory'] as const) {
    const template = source[kind];
    if (template === undefined) continue;
    if (typeof template !== 'string' || !template.includes('{{id}}')) throw new Error(`openproject.promptTemplates.${kind} must contain {{id}}.`);
    result[kind] = template;
  }
  return result;
}
/** Loads, parses, and validates OPAI's JSON configuration file. */
export async function loadConfig(): Promise<Config> {
  let raw: unknown;
  try { raw = JSON.parse(await readFile(join(configDir, 'config.json'), 'utf8')); }
  catch { throw new Error(`Run opai init to create ${join(configDir, 'config.json')}, then add your OpenProject settings.`); }
  return parseConfig(raw);
}
/** Validates an unknown value as a complete OPAI configuration. */
export function parseConfig(raw: unknown): Config {
  const c = raw as Partial<Config>;
  if (!c.openproject?.url || !c.openproject.instanceId || !Number.isInteger(c.openproject.bugTypeId) || !Number.isInteger(c.openproject.userStoryTypeId)) throw new Error('Config needs openproject.url, instanceId, bugTypeId, and userStoryTypeId. See config.example.json.');
  if (!/^https?:\/\//.test(c.openproject.url)) throw new Error('openproject.url must be an HTTP(S) URL.');
  if (new URL(c.openproject.url).hostname.endsWith('.example.com')) throw new Error(`Replace the sample openproject.url in ${join(configDir, 'config.json')} with your real OpenProject URL.`);
  if (!/^[a-zA-Z0-9_-]+$/.test(c.openproject.instanceId)) throw new Error('openproject.instanceId must contain only letters, digits, _ or -.');
  if (c.defaultAgent && !['claude','codex'].includes(c.defaultAgent)) throw new Error('defaultAgent must be claude or codex.');
  if (c.cacheTtlHours !== undefined && (typeof c.cacheTtlHours !== 'number' || !Number.isFinite(c.cacheTtlHours) || c.cacheTtlHours <= 0 || c.cacheTtlHours > 168)) throw new Error('cacheTtlHours must be greater than 0 and at most 168.');
  if (c.updateCheckDays !== undefined && (!Number.isInteger(c.updateCheckDays) || c.updateCheckDays < 0 || c.updateCheckDays > 90)) throw new Error('updateCheckDays must be an integer from 0 to 90. Use 0 to disable update checks.');
  if (c.openproject.requestTimeoutSeconds !== undefined && (!Number.isInteger(c.openproject.requestTimeoutSeconds) || c.openproject.requestTimeoutSeconds < 1 || c.openproject.requestTimeoutSeconds > 120)) throw new Error('openproject.requestTimeoutSeconds must be an integer from 1 to 120.');
  return { ...c, openproject: { ...c.openproject, promptTemplates: parsePromptTemplates(c.openproject.promptTemplates) }, models: parseConfiguredModels(c.models), cwd: c.cwd ? resolve(c.cwd) : undefined } as Config;
}
