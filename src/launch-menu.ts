import { accent, bold, warning } from './ui.js';

export type LaunchAction = 'start' | 'model' | 'effort' | 'prompt' | 'save' | 'reset-prompt';

export interface LaunchMenuChoice {
  name: string;
  value: LaunchAction;
}

/** Builds Inquirer settings for editing a prompt template in place. */
export function editablePromptConfig(message: string, current: string): {
  message: string;
  default: string;
  prefill: 'editable';
  validate: (value: string) => true | string;
} {
  return {
    message,
    default: current,
    prefill: 'editable',
    /** Requires the editable prompt to retain its ticket placeholder. */
    validate: value => value.includes('{{id}}') || 'Prompt template must contain {{id}}.'
  };
}

/** Truncates a launch-menu preview without changing its underlying value. */
function preview(value: string, max = 52): string {
  const chars = [...value];
  return chars.length > max ? `${chars.slice(0, max - 1).join('')}…` : value;
}

/** Formats Default distinctly from an explicit selected value. */
function selectedValue(value: string): string {
  return value === 'Default' ? '(Default)' : value;
}

/** Summarizes saved model and effort defaults for one agent. */
export function launchDefaultsSummary(model: string, effort: string): string {
  const defaultModel = model === 'Default';
  const defaultEffort = effort === 'Default';
  if (defaultModel && defaultEffort) return 'Agent defaults';
  const modelSummary = defaultModel ? 'Agent model' : model;
  const effortSummary = defaultEffort ? 'Agent effort' : `${effort} effort`;
  return `${modelSummary} · ${effortSummary}`;
}

/** Summarizes whether prompts use provider or custom defaults. */
export function promptDefaultsSummary(custom: boolean): string {
  return custom ? 'Custom' : 'Provider default';
}

/** Formats one aligned row in the launch-defaults screen. */
export function launchDefaultsRow(label: string, summary: string): string {
  return `  ${label.padEnd(18)}  ${summary}`;
}

/** Renders a centered separator heading for a menu section. */
export function menuSectionHeader(label: string, width = 48): string {
  const content = ` ${label} `;
  const remaining = Math.max(4, width - [...content].length);
  const left = Math.floor(remaining / 2);
  const right = remaining - left;
  return `${'─'.repeat(left)}${content}${'─'.repeat(right)}`;
}

/** Builds the launch-options choices and restores focus to the last edit. */
export function buildLaunchMenu(
  model: string,
  effort: string,
  prompt: string,
  focus: LaunchAction = 'start',
  availability: { model?: boolean; effort?: boolean } = {}
): { default: LaunchAction; choices: LaunchMenuChoice[] } {
  const modelWarning = availability.model === false ? warning(' · unavailable') : '';
  const effortWarning = availability.effort === false ? warning(' · unavailable') : '';
  return {
    default: focus,
    choices: [
      { name: '▶  Start session', value: 'start' },
      { name: `◈  Model · ${accent(bold(selectedValue(model)))}${modelWarning}`, value: 'model' },
      { name: `✦  Effort · ${warning(bold(selectedValue(effort)))}${effortWarning}`, value: 'effort' },
      { name: `✎  Prompt · ${accent(preview(prompt))}`, value: 'prompt' },
      { name: '★  Save current options as defaults', value: 'save' },
      { name: '↺  Reset prompt to configured default', value: 'reset-prompt' }
    ]
  };
}
