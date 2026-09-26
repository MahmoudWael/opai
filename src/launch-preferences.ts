import { mkdir, readFile, rename, writeFile } from 'node:fs/promises';
import { dirname, join } from 'node:path';
import { randomUUID } from 'node:crypto';
import { configDir } from './config.js';
import type { Agent } from './agents/types.js';
import type { PromptKind } from './providers/types.js';
import { isModelId, type ModelPreference } from './models.js';

export interface AgentLaunchDefaults { model: ModelPreference; effort: string | null }
export interface LaunchPreferences {
  agents: Record<Agent, AgentLaunchDefaults>;
  prompts: Record<string, Partial<Record<PromptKind, string>>>;
}

/** Creates default launch preferences for every supported agent. */
function emptyPreferences(): LaunchPreferences {
  return { agents: { claude: { model: null, effort: null }, codex: { model: null, effort: null } }, prompts: {} };
}

/** Parses an optional model or effort identifier. */
function optionalId(value: unknown, label: string): string | null {
  if (value === undefined || value === null) return null;
  if (!isModelId(value)) throw new Error(`Invalid ${label}: ${JSON.stringify(value)}.`);
  return value;
}

/** Validates that a prompt template contains the ticket placeholder. */
function validateTemplate(value: unknown): string {
  if (typeof value !== 'string' || !value.includes('{{id}}')) throw new Error('Prompt template must contain {{id}}.');
  return value;
}

export class LaunchPreferenceStore {
  /** Creates a launch-preference store backed by the supplied JSON file. */
  constructor(readonly path = join(configDir, 'launch-preferences.json')) {}
  /** Loads and validates all launch preferences with backward-compatible defaults. */
  async all(): Promise<LaunchPreferences> {
    let raw: unknown;
    try { raw = JSON.parse(await readFile(this.path, 'utf8')); }
    catch (error) {
      if ((error as NodeJS.ErrnoException).code === 'ENOENT') return emptyPreferences();
      throw error;
    }
    if (!raw || typeof raw !== 'object' || Array.isArray(raw)) throw new Error('Invalid launch preferences file.');
    const value = raw as Record<string, unknown>;
    const rawAgents = value.agents && typeof value.agents === 'object' && !Array.isArray(value.agents) ? value.agents as Record<string, unknown> : {};
    const agents = {} as Record<Agent, AgentLaunchDefaults>;
    for (const agent of ['claude', 'codex'] as const) {
      const entry = rawAgents[agent] && typeof rawAgents[agent] === 'object' && !Array.isArray(rawAgents[agent]) ? rawAgents[agent] as Record<string, unknown> : {};
      agents[agent] = { model: optionalId(entry.model, `${agent} model`), effort: optionalId(entry.effort, `${agent} effort`) };
    }
    const prompts: LaunchPreferences['prompts'] = {};
    if (value.prompts !== undefined && (!value.prompts || typeof value.prompts !== 'object' || Array.isArray(value.prompts))) throw new Error('Invalid launch prompt preferences.');
    for (const [provider, entry] of Object.entries((value.prompts ?? {}) as Record<string, unknown>)) {
      if (!entry || typeof entry !== 'object' || Array.isArray(entry)) throw new Error(`Invalid prompt preferences for ${provider}.`);
      const source = entry as Record<string, unknown>;
      const normalized: Partial<Record<PromptKind, string>> = {};
      if (source.bug !== undefined) normalized.bug = validateTemplate(source.bug);
      if (source.userStory !== undefined) normalized.userStory = validateTemplate(source.userStory);
      if (Object.keys(normalized).length) prompts[provider] = normalized;
    }
    return { agents, prompts };
  }
  /** Atomically persists launch preferences. */
  private async save(value: LaunchPreferences): Promise<void> {
    await mkdir(dirname(this.path), { recursive: true, mode: 0o700 });
    const temp = `${this.path}.${randomUUID()}.tmp`;
    await writeFile(temp, JSON.stringify(value, null, 2) + '\n', { mode: 0o600, flag: 'wx' });
    await rename(temp, this.path);
  }
  /** Saves the preferred model and effort for one agent. */
  async setAgent(agent: Agent, defaults: AgentLaunchDefaults): Promise<void> {
    const value = await this.all();
    value.agents[agent] = {
      model: optionalId(defaults.model, `${agent} model`),
      effort: optionalId(defaults.effort, `${agent} effort`)
    };
    await this.save(value);
  }
  /** Saves or clears a provider-specific prompt template. */
  async setPrompt(provider: string, kind: PromptKind, template: string | null): Promise<void> {
    const value = await this.all();
    if (template === null) {
      if (value.prompts[provider]) {
        delete value.prompts[provider][kind];
        if (!Object.keys(value.prompts[provider]).length) delete value.prompts[provider];
      }
    } else {
      value.prompts[provider] ??= {};
      value.prompts[provider][kind] = validateTemplate(template);
    }
    await this.save(value);
  }
}
