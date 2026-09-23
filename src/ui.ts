import type { Ticket } from './providers/types.js';
import type { TicketSessions } from './sessions/store.js';
import { stripVTControlCharacters } from 'node:util';
import { statusBar } from './status.js';

const color = process.stdout.isTTY && !process.env.NO_COLOR;
const paint = (code: number, value: string) => color ? `\u001b[${code}m${value}\u001b[0m` : value;
type Colorizer = (value: string) => string;
export interface OpaiPalette {
  accent: Colorizer;
  mascot: Colorizer;
  positive: Colorizer;
  warning: Colorizer;
  danger: Colorizer;
  muted: Colorizer;
}
export function createOpaiPalette(enabled = color): OpaiPalette {
  const rgb = (red: number, green: number, blue: number): Colorizer => value => enabled
    ? `\u001b[38;2;${red};${green};${blue}m${value}\u001b[0m`
    : value;
  return {
    accent: rgb(148, 226, 213),
    mascot: rgb(245, 194, 231),
    positive: rgb(166, 227, 161),
    warning: rgb(249, 226, 175),
    danger: rgb(243, 139, 168),
    muted: rgb(88, 91, 112)
  };
}
const opaiPalette = createOpaiPalette();
export const accent = opaiPalette.accent;
export const muted = opaiPalette.muted;
export const bold = (value: string): string => paint(1, value);
export const warning = opaiPalette.warning;
export const good = opaiPalette.positive;
export const danger = opaiPalette.danger;
const magic = opaiPalette.mascot;
export function selectionCursor(value = '❯', animated = color): string {
  return animated ? `\u001b[5m${value}\u001b[25m` : value;
}

function truncate(value: string, max: number): string {
  const chars = [...value];
  return chars.length > max ? `${chars.slice(0, Math.max(0, max - 1)).join('')}…` : value;
}
export function visibleWidth(value: string): number {
  let width = 0;
  for (const char of stripVTControlCharacters(value)) {
    if (/\p{Mark}/u.test(char)) continue;
    const code = char.codePointAt(0)!;
    width += code >= 0x1100 && (
      code <= 0x115f || code === 0x2329 || code === 0x232a ||
      (code >= 0x2e80 && code <= 0xa4cf) || (code >= 0xac00 && code <= 0xd7a3) ||
      (code >= 0xf900 && code <= 0xfaff) || (code >= 0xfe10 && code <= 0xfe6f) ||
      (code >= 0xff00 && code <= 0xff60) || (code >= 0x1f300 && code <= 0x1faff)
    ) ? 2 : 1;
  }
  return width;
}
function truncateVisible(value: string, max: number): string {
  if (max <= 0) return '';
  if (visibleWidth(value) <= max) return value;
  let result = '';
  let width = 0;
  for (const char of value) {
    const next = visibleWidth(char);
    if (width + next > max - 1) break;
    result += char;
    width += next;
  }
  return `${result}…`;
}
function padVisible(value: string, width: number): string { return value + ' '.repeat(Math.max(0, width - visibleWidth(value))); }
export function ticketRow(ticket: Ticket, columns = process.stdout.columns ?? 80): string {
  const rawBadge = ticket.type === 'Bug' ? 'Bug' : ticket.type === 'User Story' ? 'US' : truncate(ticket.typeLabel, 24);
  const usableWidth = Math.max(20, columns - 4);
  const typeWidth = 3;
  const statusWidth = 11;
  const priorityWidth = 8;
  const fixedWidth = 8 + 1 + 2 + typeWidth + 1 + statusWidth + 2 + priorityWidth;
  const titleWidth = Math.max(6, Math.min(58, usableWidth - fixedWidth));
  const id = truncate(`#${ticket.id}`, 8).padEnd(8);
  const title = truncate(ticket.title, titleWidth).padEnd(titleWidth);
  const type = truncate(rawBadge, typeWidth).padEnd(typeWidth);
  const status = truncate(ticket.status, statusWidth).padEnd(statusWidth);
  const priority = truncate(ticket.priority?.name ?? '', priorityWidth).padEnd(priorityWidth);
  const badge = ticket.type === 'Bug' ? danger(type) : ticket.type === 'User Story' ? accent(type) : warning(type);
  return `${accent(id)} ${title}  ${badge} ${muted(status)}  ${ticket.priority ? bold(priority) : priority}`;
}
export function listHighlight(value: string, columns = process.stdout.columns ?? 80): string {
  const width = Math.max(1, columns - 2);
  return stripVTControlCharacters(value).split('\n').map(line => {
    const row = line.padEnd(width);
    const animatedRow = row.startsWith('❯') ? `${selectionCursor('❯')}${row.slice(1)}` : row;
    return color ? `\u001b[7m${animatedRow}\u001b[0m` : row;
  }).join('\n');
}
export function sinceLastOpened(value: string, now = Date.now()): string {
  const elapsed = now - Date.parse(value);
  if (!Number.isFinite(elapsed) || elapsed < 0) return 'just now';
  const minutes = Math.floor(elapsed / 60_000);
  if (minutes < 1) return 'just now';
  if (minutes < 60) return `${minutes}m ago`;
  const hours = Math.floor(minutes / 60);
  if (hours < 24) return `${hours}h ago`;
  const days = Math.floor(hours / 24);
  if (days < 30) return `${days}d ago`;
  const months = Math.floor(days / 30);
  if (months < 12) return `${months}mo ago`;
  return `${Math.floor(days / 365)}y ago`;
}
export function sessionRow(group: TicketSessions, columns = process.stdout.columns ?? 80, now = Date.now()): string {
  const agents = [...new Set(group.sessions.map(session => session.agent === 'claude' ? 'Claude' : 'Codex'))].join(' + ');
  const details = `${agents} · ${group.sessions.length} session${group.sessions.length === 1 ? '' : 's'} · last opened ${sinceLastOpened(group.lastUsedAt, now)}`;
  const usableWidth = Math.max(20, columns - 4);
  const statusWidth = 20;
  const titleWidth = Math.max(8, Math.min(58, usableWidth - 8 - 2 - 2 - statusWidth));
  const id = truncate(`#${group.id}`, 8).padEnd(8);
  const title = truncate(group.title, titleWidth).padEnd(titleWidth);
  const rawStatus = group.status ? `[${truncate(group.status, 18)}]` : '[Status unavailable]';
  const status = rawStatus.padEnd(statusWidth);
  const detailIndent = '      ';
  const visibleDetails = truncateVisible(details, Math.max(1, usableWidth - detailIndent.length));
  return `${accent(id)}  ${bold(title)}  ${group.status ? accent(status) : muted(status)}\n${detailIndent}${muted(visibleDetails)}`;
}
export type IdleMascotMood = 'idle' | 'rabbit' | 'chick';
export type MascotMood = IdleMascotMood | 'claude' | 'codex' | 'resume' | 'loading' | 'success' | 'error';
const mascots: Record<MascotMood, [string, string, string]> = {
  idle: [' /\\_/\\', '(˶ᵔ ᵕ ᵔ˶)✧', ' /|☆|\\'],
  rabbit: ['  /) /)', '(˶ᵔ ᵕ ᵔ˶)', ' /づ♡づ'],
  chick: ['   ,_,', ' (˶•ө•˶)', '  /づ✦づ'],
  claude: [' /\\_/\\', '(˶ᵔ ᴗ ᵔ˶)✦', ' /|⌁|\\'],
  codex: [' /\\_/\\', '(˶• ⩊ •˶)⚙', ' /|#|\\'],
  resume: [' /\\_/\\', '(˶ᵔ ᴗ ᵔ˶)↻', ' /|☆|\\'],
  loading: [' /\\_/\\', '(˶• ᴗ •˶)⋯', ' /|…|\\'],
  success: [' /\\_/\\', '(˶ᵔ ᴗ ᵔ˶)☆', ' /|☆|\\'],
  error: [' /\\_/\\', '(˶• ᴗ •˶)♡', ' /|!|\\']
};
const mascotWidth = Math.max(...Object.values(mascots).flat().map(visibleWidth));
let idleMascotMood: IdleMascotMood = 'idle';

export function setIdleMascotMood(mood: IdleMascotMood): void {
  idleMascotMood = mood;
}

function headerParts(title: string, subtitle: string | undefined, status: { kind: string; message: string }, columns: number, mood: MascotMood): { art: string[]; content: string[]; stacked: boolean } {
  const art = mascots[mood];
  const symbol = status.kind === 'success' ? '✓' : status.kind === 'error' ? '!' : status.kind === 'loading' ? '◌' : status.kind === 'cached' ? '◆' : '◇';
  const content = [`OPAI › ${title}`, subtitle ?? '', `${symbol} ${status.message}`];
  const contentStart = 2 + mascotWidth + 3;
  if (columns < contentStart + 8) {
    return { art: art.map(line => `  ${line}`), content: content.map(line => `  ${truncateVisible(line, Math.max(1, columns - 2))}`), stacked: true };
  }
  const available = Math.max(1, columns - contentStart);
  return { art: art.map(line => `  ${padVisible(line, mascotWidth)}   `), content: content.map(line => truncateVisible(line, available)), stacked: false };
}

export function renderHeader(title: string, subtitle: string | undefined, status: { kind: string; message: string }, columns = 80, mood: MascotMood = idleMascotMood): string {
  const parts = headerParts(title, subtitle, status, columns, mood);
  return parts.stacked
    ? [...parts.art, ...parts.content].join('\n')
    : parts.art.map((art, index) => `${art}${parts.content[index]}`).join('\n');
}

function centeredLine(value: string, columns: number, style: Colorizer = text => text): string {
  const fitted = truncateVisible(value, Math.max(1, columns));
  const left = Math.max(0, Math.floor((columns - visibleWidth(fitted)) / 2));
  return `${' '.repeat(left)}${style(fitted)}`;
}

export function renderAgentClosed(detail: string, mood: 'success' | 'error' = 'success', columns = 80): string {
  return [
    ...mascots[mood].map(line => centeredLine(line, columns, magic)),
    '',
    centeredLine('Session closed', columns, value => bold(accent(value))),
    centeredLine(detail, columns, mood === 'error' ? warning : muted)
  ].join('\n');
}

export function centeredMenuChoices(labels: string[], columns = process.stdout.columns ?? 80): string[] {
  const width = Math.max(0, ...labels.map(visibleWidth));
  const left = Math.max(0, Math.floor((columns - width - 2) / 2));
  return labels.map(label => `${' '.repeat(left)}${label}`);
}

export function agentClosedScreen(detail: string, mood: 'success' | 'error' = 'success'): void {
  if (process.stdout.isTTY) process.stdout.write('\u001b[2J\u001b[H');
  console.log(`\n${renderAgentClosed(detail, mood, process.stdout.columns ?? 80)}\n`);
}

export function screen(title: string, subtitle?: string, mood?: MascotMood): void {
  if (process.stdout.isTTY) process.stdout.write('\u001b[2J\u001b[H');
  const { kind, message } = statusBar.current;
  const selectedMood = mood ?? (kind === 'loading' ? 'loading' : kind === 'success' ? 'success' : kind === 'error' ? 'error' : idleMascotMood);
  const parts = headerParts(title, subtitle, { kind, message }, process.stdout.columns ?? 80, selectedMood);
  const styleContent = (value: string, index: number) => index === 0 ? bold(accent(value)) : index === 1 ? muted(value) : kind === 'success' ? good(value) : kind === 'error' ? warning(value) : kind === 'loading' ? accent(value) : muted(value);
  const styled = parts.stacked
    ? [...parts.art.map(magic), ...parts.content.map(styleContent)].join('\n')
    : parts.art.map((art, index) => `${magic(art)}${styleContent(parts.content[index]!, index)}`).join('\n');
  console.log(`\n${styled}\n`);
}
export function hint(): string { return muted('↑↓ move · type to filter · Enter select · Esc back · Ctrl+C exit'); }

export function renderGoodbye(mood: IdleMascotMood = idleMascotMood): string {
  const art = mood === 'rabbit'
    ? ['  /) /)', '₍ᐢ..ᐢ₎♡', '  /づづ']
    : [' /\\_/\\', '(˶ᵔ ᵕ ᵔ˶)ﾉ', ' /|☆|\\'];
  return [
    `  ${magic(art[0]!)}`,
    `  ${magic(art[1]!)}  ${bold('See you next quest, adventurer!')} ${accent('✦')}`,
    `  ${magic(art[2]!)}   ${muted('Your saved sessions will be here when you return.')}`
  ].join('\n');
}

export function goodbye(): void {
  if (!process.stdout.isTTY) return;
  console.log(`\n${renderGoodbye()}\n`);
}
