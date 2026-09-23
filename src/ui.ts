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
export function ticketRow(ticket: Ticket, columns = process.stdout.columns ?? 80): string {
  const rawBadge = ticket.type === 'Bug' ? 'Bug' : ticket.type === 'User Story' ? 'User Story' : truncate(ticket.typeLabel, 24);
  const badge = ticket.type === 'Bug' ? paint(31, rawBadge) : ticket.type === 'User Story' ? accent(rawBadge) : warning(rawBadge);
  const id = `#${ticket.id}`.padEnd(8);
  const typeWidth = [...rawBadge].length;
  const status = truncate(ticket.status, 14);
  const priority = ticket.priority ? truncate(ticket.priority.name, 10) : '';
  const titleWidth = Math.max(8, Math.min(58, columns - 22 - typeWidth - status.length - (priority ? priority.length + 2 : 0)));
  const title = truncate(ticket.title, titleWidth).padEnd(titleWidth);
  return `${accent(id)} ${title}  ${badge}  ${muted(status)}${priority ? `  ${bold(priority)}` : ''}`;
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
  const status = group.status ? `[${truncate(group.status, 18)}]` : '[Status unavailable]';
  const titleWidth = Math.max(8, Math.min(58, columns - 10 - group.id.length - [...status].length));
  return `${accent(`#${group.id}`)}  ${bold(truncate(group.title, titleWidth).padEnd(titleWidth))}  ${group.status ? accent(status) : muted(status)}\n      ${muted(details)}`;
}
export function screen(title: string, subtitle?: string): void {
  if (process.stdout.isTTY) process.stdout.write('\u001b[2J\u001b[H');
  const width = Math.max(30, (process.stdout.columns ?? 80) - 14);
  const { kind, message } = statusBar.current;
  const symbol = kind === 'success' ? '✓' : kind === 'error' ? '!' : kind === 'loading' ? '◌' : kind === 'cached' ? '◆' : '◇';
  const status = `${symbol} ${message}`;
  const styledStatus = kind === 'success' ? good(status) : kind === 'error' ? warning(status) : kind === 'loading' ? accent(status) : muted(status);
  console.log(`\n  ${magic(' /\\_/\\')}   ${bold(accent('OPAI'))}  ${muted('›')}  ${bold(truncate(title, width))}`);
  console.log(`  ${magic('( •̀ᴗ•́)⚔')}  ${subtitle ? muted(truncate(subtitle, Math.max(30, (process.stdout.columns ?? 80) - 16))) : ''}`);
  console.log(`  ${magic(' /|☆|\\')}   ${styledStatus}`);
  console.log();
}
export function hint(): string { return muted('↑↓ move · type to filter · Enter select · Esc back · Ctrl+C exit'); }

export function goodbye(): void {
  if (!process.stdout.isTTY) return;
  console.log(`\n  ${magic(' /\\_/\\')}`);
  console.log(`  ${magic('(˶ᵔ ᵕ ᵔ˶)ﾉ')}  ${bold('See you next quest, adventurer!')} ${accent('✦')}`);
  console.log(`  ${magic(' /|☆|\\')}   ${muted('Your saved sessions will be here when you return.')}\n`);
}
