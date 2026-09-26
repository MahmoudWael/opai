import type { Agent } from './agents/types.js';

export type ModelPreference = string | null;
export interface ConfiguredModels { claude?: string[]; codex?: string[] }
export interface ModelOption { name: string; value: ModelPreference }

const CLAUDE_ALIASES = ['sonnet', 'opus', 'haiku'];

/** Reports whether a value is a safe agent model identifier. */
export function isModelId(value: unknown): value is string {
  return typeof value === 'string' && /^[A-Za-z0-9][A-Za-z0-9._:/@+\[\]-]{0,199}$/.test(value);
}

/** Throws when a configured model identifier is malformed. */
function validateModelId(agent: Agent, value: string): void {
  if (!isModelId(value)) throw new Error(`Invalid ${agent} model ID: ${JSON.stringify(value)}.`);
}

/** Parses per-agent custom model identifiers from configuration. */
export function parseConfiguredModels(value: unknown): ConfiguredModels | undefined {
  if (value === undefined) return undefined;
  if (!value || typeof value !== 'object' || Array.isArray(value)) throw new Error('models must be an object.');
  const models = value as Record<string, unknown>;
  for (const agent of ['claude', 'codex'] as const) {
    const entries = models[agent];
    if (entries === undefined) continue;
    if (!Array.isArray(entries)) throw new Error(`models.${agent} must be an array of model IDs.`);
    for (const model of entries) validateModelId(agent, model as string);
  }
  return {
    ...(models.claude !== undefined ? { claude: [...models.claude as string[]] } : {}),
    ...(models.codex !== undefined ? { codex: [...models.codex as string[]] } : {})
  };
}

/** Builds selectable model options for an agent, including Default. */
export function modelOptions(agent: Agent, configured: string[] = []): ModelOption[] {
  for (const model of configured) validateModelId(agent, model);
  const models = agent === 'claude' ? [...CLAUDE_ALIASES, ...configured] : configured;
  const unique = [...new Set(models)];
  return [
    { name: 'Default', value: null },
    ...unique.map(value => ({ name: CLAUDE_ALIASES.includes(value) ? value[0]!.toUpperCase() + value.slice(1) : value, value }))
  ];
}

/** Validates a saved model preference against the agent's available options. */
export function resolvePreferredModel(agent: Agent, preference: ModelPreference, configured: string[] = []): ModelPreference {
  if (preference === null) return null;
  validateModelId(agent, preference);
  if (!modelOptions(agent, configured).some(option => option.value === preference)) {
    throw new Error(`Saved ${agent} model ${JSON.stringify(preference)} is not available. Change Launch defaults or add it to config.json.`);
  }
  return preference;
}

/** Returns the human-readable label for a model preference. */
export function modelLabel(model: ModelPreference): string {
  return model === null ? 'Default' : model;
}
