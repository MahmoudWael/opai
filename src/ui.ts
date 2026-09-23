import type { Ticket } from './providers/types.js';
import type { TicketSessions } from './sessions/store.js';
import { stripVTControlCharacters } from 'node:util';
import { statusBar } from './status.js';

const color = process.stdout.isTTY && !process.env.NO_COLOR;
const paint = (code: number, value: string) => color ? `\u001b[${code}m${value}\u001b[0m` : value;
export const accent = (value: string): string => paint(36, value);
export const muted = (value: string): string => paint(90, value);
export const bold = (value: string): string => paint(1, value);
export const warning = (value: string): string => paint(33, value);
export const good = (value: string): string => paint(32, value);
const magic = (value: string): string => paint(35, value);

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
  const badge = ticket.type === 'Bug' ? paint(31, type) : ticket.type === 'User Story' ? accent(type) : warning(type);
  return `${accent(id)} ${title}  ${badge} ${muted(status)}  ${ticket.priority ? bold(priority) : priority}`;
}
export function listHighlight(value: string, columns = process.stdout.columns ?? 80): string {
  const width = Math.max(1, columns - 2);
  return stripVTControlCharacters(value).split('\n').map(line => {
    const row = line.padEnd(width);
    return color ? `\u001b[7m${row}\u001b[0m` : row;
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
export type MascotMood = 'idle' | 'claude' | 'codex' | 'resume' | 'loading' | 'success' | 'error';
const mascots: Record<MascotMood, [string, string, string]> = {
  idle: [' /\\_/\\', '(˶ᵔ ᵕ ᵔ˶)✧', ' /|☆|\\'],
  claude: [' /\\_/\\', '(˶ᵔ ᴗ ᵔ˶)✦', ' /|⌁|\\'],
  codex: [' /\\_/\\', '(˶• ⩊ •˶)⚙', ' /|#|\\'],
  resume: [' /\\_/\\', '(˶ᵔ ᴗ ᵔ˶)↻', ' /|☆|\\'],
  loading: [' /\\_/\\', '(˶• ᴗ •˶)⋯', ' /|…|\\'],
  success: [' /\\_/\\', '(˶ᵔ ᴗ ᵔ˶)☆', ' /|☆|\\'],
  error: [' /\\_/\\', '(˶• ᴗ •˶)♡', ' /|!|\\']
};
const mascotWidth = Math.max(...Object.values(mascots).flat().map(visibleWidth));

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

export function renderHeader(title: string, subtitle: string | undefined, status: { kind: string; message: string }, columns = 80, mood: MascotMood = 'idle'): string {
  const parts = headerParts(title, subtitle, status, columns, mood);
  return parts.stacked
    ? [...parts.art, ...parts.content].join('\n')
    : parts.art.map((art, index) => `${art}${parts.content[index]}`).join('\n');
}

export function screen(title: string, subtitle?: string, mood?: MascotMood): void {
  if (process.stdout.isTTY) process.stdout.write('\u001b[2J\u001b[H');
  const { kind, message } = statusBar.current;
  const selectedMood = mood ?? (kind === 'loading' ? 'loading' : kind === 'success' ? 'success' : kind === 'error' ? 'error' : 'idle');
  const parts = headerParts(title, subtitle, { kind, message }, process.stdout.columns ?? 80, selectedMood);
  const styleContent = (value: string, index: number) => index === 0 ? bold(accent(value)) : index === 1 ? muted(value) : kind === 'success' ? good(value) : kind === 'error' ? warning(value) : kind === 'loading' ? accent(value) : muted(value);
  const styled = parts.stacked
    ? [...parts.art.map(magic), ...parts.content.map(styleContent)].join('\n')
    : parts.art.map((art, index) => `${magic(art)}${styleContent(parts.content[index]!, index)}`).join('\n');
  console.log(`\n${styled}\n`);
}
export function hint(): string { return muted('↑↓ move · type to filter · Enter select · Esc back · Ctrl+C exit'); }

export function goodbye(): void {
  if (!process.stdout.isTTY) return;
  console.log(`\n  ${magic(' /\\_/\\')}`);
  console.log(`  ${magic('(˶ᵔ ᵕ ᵔ˶)ﾉ')}  ${bold('See you next quest, adventurer!')} ${accent('✦')}`);
  console.log(`  ${magic(' /|☆|\\')}   ${muted('Your saved sessions will be here when you return.')}\n`);
}
