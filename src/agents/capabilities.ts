import { execFile } from 'node:child_process';
import type { Agent } from './types.js';
import { isModelId } from '../models.js';

export interface AgentModel {
  id: string;
  label: string;
  defaultEffort?: string;
  efforts: string[];
}

export interface AgentCapabilities {
  models: AgentModel[];
  efforts: string[];
  discovered: boolean;
}

export function availableEfforts(capabilities: AgentCapabilities, model: string | null): string[] {
  const selected = model ? capabilities.models.find(item => item.id === model) : undefined;
  if (selected?.efforts.length) return [...selected.efforts];
  return unique([...capabilities.efforts, ...capabilities.models.flatMap(item => item.efforts)]);
}

export function resolveEffort(effort: string | null, available: string[]): string | null {
  if (effort === null) return null;
  if (!available.includes(effort)) throw new Error(`Saved effort ${JSON.stringify(effort)} is not available for the selected model.`);
  return effort;
}

const CLAUDE_ALIASES = ['sonnet', 'opus', 'haiku'];
const CLAUDE_EFFORTS = ['low', 'medium', 'high', 'xhigh', 'max'];

function unique(values: string[]): string[] { return [...new Set(values)]; }

export function parseCodexModelCatalog(raw: string, configured: string[] = []): AgentModel[] {
  const value: unknown = JSON.parse(raw);
  if (!value || typeof value !== 'object' || !Array.isArray((value as { models?: unknown }).models)) throw new Error('Codex returned an invalid model catalog.');
  const models: AgentModel[] = [];
  for (const item of (value as { models: unknown[] }).models) {
    if (!item || typeof item !== 'object') continue;
    const model = item as Record<string, unknown>;
    if (model.visibility !== 'list' || !isModelId(model.slug) || typeof model.display_name !== 'string') continue;
    const levels = Array.isArray(model.supported_reasoning_levels) ? model.supported_reasoning_levels : [];
    const efforts = levels.flatMap(level => level && typeof level === 'object' && typeof (level as { effort?: unknown }).effort === 'string' ? [(level as { effort: string }).effort] : []);
    models.push({
      id: model.slug,
      label: model.display_name,
      ...(typeof model.default_reasoning_level === 'string' ? { defaultEffort: model.default_reasoning_level } : {}),
      efforts: unique(efforts)
    });
  }
  for (const id of configured) {
    if (!isModelId(id)) throw new Error(`Invalid codex model ID: ${JSON.stringify(id)}.`);
    if (!models.some(model => model.id === id)) models.push({ id, label: id, efforts: [] });
  }
  return models;
}

function optionBlock(help: string, flag: string): string {
  const start = help.indexOf(flag);
  if (start < 0) return '';
  const end = help.indexOf('\n  --', start + flag.length);
  return help.slice(start, end < 0 ? undefined : end);
}

export function parseClaudeHelp(help: string, configured: string[] = []): AgentCapabilities {
  const modelBlock = optionBlock(help, '--model <model>');
  const aliasText = modelBlock.split("or a model's full name")[0] ?? '';
  const discoveredAliases = [...aliasText.matchAll(/'([A-Za-z0-9._:/@-]+)'/g)].map(match => match[1]);
  const ids = unique([...CLAUDE_ALIASES, ...discoveredAliases, ...configured]);
  for (const id of ids) if (!isModelId(id)) throw new Error(`Invalid claude model ID: ${JSON.stringify(id)}.`);
  const effortBlock = optionBlock(help, '--effort <level>');
  const efforts = CLAUDE_EFFORTS.filter(effort => new RegExp(`\\b${effort}\\b`).test(effortBlock));
  return {
    models: ids.map(id => ({ id, label: id[0]!.toUpperCase() + id.slice(1), efforts: [] })),
    efforts: efforts.length ? efforts : [...CLAUDE_EFFORTS],
    discovered: Boolean(modelBlock || effortBlock)
  };
}

type CommandReader = (executable: string, args: string[]) => Promise<string>;
const readCommand: CommandReader = (executable, args) => new Promise((resolve, reject) => {
  execFile(executable, args, { maxBuffer: 2 * 1024 * 1024 }, (error, stdout) => error ? reject(error) : resolve(stdout));
});

export async function discoverAgentCapabilities(agent: Agent, executable: string, configured: string[] = [], run: CommandReader = readCommand): Promise<AgentCapabilities> {
  if (agent === 'claude') {
    try { return parseClaudeHelp(await run(executable, ['--help']), configured); }
    catch { return parseClaudeHelp('', configured); }
  }
  try {
    const models = parseCodexModelCatalog(await run(executable, ['debug', 'models', '--bundled']), configured);
    return { models, efforts: [], discovered: true };
  } catch {
    return { models: configured.map(id => ({ id, label: id, efforts: [] })), efforts: [], discovered: false };
  }
}
