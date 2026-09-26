import { mkdir, readFile, rename, writeFile } from 'node:fs/promises';
import { dirname, join } from 'node:path';
import { randomUUID } from 'node:crypto';
import { configDir } from './config.js';
import type { Ticket } from './providers/types.js';
import type { Registry, Session } from './sessions/store.js';
import { accent, bold, danger, good, warning } from './ui.js';

export interface DailySnapshot { date: string; refreshedAt: number; ticketIds: string[]; total: number }
type History = Record<string, DailySnapshot[]>;

/** Formats a local calendar date as a stable dashboard-history key. */
function dayKey(value: Date): string {
  return `${value.getFullYear()}-${String(value.getMonth() + 1).padStart(2, '0')}-${String(value.getDate()).padStart(2, '0')}`;
}
/** Reports whether parsed JSON can serve as dashboard history. */
function validHistory(value: unknown): value is History {
  return Boolean(value) && typeof value === 'object' && !Array.isArray(value);
}
export class DashboardHistoryStore {
  private writable = true;
  /** Creates a history store backed by the supplied JSON file. */
  constructor(readonly path = join(configDir, 'dashboard-history.json')) {}
  /** Reads all dashboard snapshots, treating missing or invalid data as empty. */
  private async all(): Promise<History> {
    try { const value: unknown = JSON.parse(await readFile(this.path, 'utf8')); return validHistory(value) ? value : {}; }
    catch { return {}; }
  }
  /** Atomically persists all dashboard snapshots. */
  private async save(value: History): Promise<void> {
    await mkdir(dirname(this.path), { recursive: true, mode: 0o700 });
    const temp = `${this.path}.${randomUUID()}.tmp`;
    await writeFile(temp, `${JSON.stringify(value, null, 2)}\n`, { mode: 0o600 });
    await rename(temp, this.path);
  }
  /** Records or replaces the provider's snapshot for one calendar day. */
  async record(provider: string, tickets: Ticket[], at = new Date()): Promise<void> {
    if (!this.writable) return;
    const history = await this.all();
    const snapshot: DailySnapshot = { date: dayKey(at), refreshedAt: at.getTime(), ticketIds: [...new Set(tickets.map(ticket => ticket.id))], total: tickets.length };
    const previous = history[provider] ?? [];
    const same = previous.find(item => item.date === snapshot.date);
    if (same?.refreshedAt === snapshot.refreshedAt && same.total === snapshot.total && same.ticketIds.join('\0') === snapshot.ticketIds.join('\0')) return;
    history[provider] = [...previous.filter(item => item.date !== snapshot.date), snapshot]
      .filter(item => item.refreshedAt >= at.getTime() - 35 * 86_400_000)
      .sort((a, b) => a.refreshedAt - b.refreshedAt);
    try { await this.save(history); }
    catch { this.writable = false; }
  }
  /** Lists retained daily snapshots for a provider. */
  async list(provider: string): Promise<DailySnapshot[]> { return (await this.all())[provider] ?? []; }
}

export interface DashboardModel {
  open: number; bugs: number; stories: number; sessions: number; resumable: number;
  refreshedAt?: number; statuses: [string, number][]; agents: { claude: number; codex: number };
  activity: { label: string; count: number }[]; trend: { label: string; count: number }[];
  touchedThisWeek: number; weeklyGoal: number; clearedThisWeek: number; clearGoal: number;
  recent?: { id: string; title: string; status?: string; agent: string; at: number };
}
/** Returns the distinct valid timestamps recorded for a native session. */
function activityTimes(session: Session): number[] {
  const values = session.usedAt?.length ? session.usedAt : [session.createdAt, session.lastUsedAt].filter((value): value is string => Boolean(value));
  return [...new Set(values)].map(Date.parse).filter(Number.isFinite);
}
/** Aggregates tickets, sessions, and history into dashboard-ready statistics. */
export function buildDashboard(tickets: Ticket[], refreshedAt: number | undefined, registry: Registry, provider: string, history: DailySnapshot[], now = Date.now()): DashboardModel {
  const groups = Object.entries(registry).filter(([key, sessions]) => key.startsWith(`${provider}:`) && sessions.length);
  const sessions = groups.flatMap(([key, values]) => values.map(session => ({ key, session })));
  const statuses = [...tickets.reduce((counts, ticket) => counts.set(ticket.status, (counts.get(ticket.status) ?? 0) + 1), new Map<string, number>())]
    .sort((a, b) => b[1] - a[1] || a[0].localeCompare(b[0]));
  const start = new Date(now); start.setHours(0, 0, 0, 0); start.setDate(start.getDate() - 6);
  const days = Array.from({ length: 7 }, (_, offset) => { const date = new Date(start); date.setDate(start.getDate() + offset); return date; });
  const events = sessions.flatMap(item => activityTimes(item.session).map(at => ({ ...item, at })));
  const activity = days.map(date => ({ label: new Intl.DateTimeFormat(undefined, { weekday: 'narrow' }).format(date), count: events.filter(event => dayKey(new Date(event.at)) === dayKey(date)).length }));
  const touched = new Set(events.filter(event => event.at >= start.getTime() && event.at <= now).map(event => event.key));
  const recentEvent = [...events].filter(event => event.at <= now).sort((a, b) => b.at - a.at)[0];
  const recentTicket = recentEvent?.session.ticket;
  const snapshots = history.filter(item => item.refreshedAt >= start.getTime() && item.refreshedAt <= now).sort((a, b) => a.refreshedAt - b.refreshedAt);
  const cleared = new Set<string>();
  for (let index = 1; index < snapshots.length; index++) {
    const current = new Set(snapshots[index].ticketIds);
    for (const id of snapshots[index - 1].ticketIds) if (!current.has(id)) cleared.add(id);
  }
  return {
    open: tickets.length,
    bugs: tickets.filter(ticket => ticket.type === 'Bug').length,
    stories: tickets.filter(ticket => ticket.type === 'User Story').length,
    sessions: sessions.length,
    resumable: groups.length,
    refreshedAt,
    statuses,
    agents: { claude: sessions.filter(item => item.session.agent === 'claude').length, codex: sessions.filter(item => item.session.agent === 'codex').length },
    activity,
    trend: snapshots.map(item => ({ label: item.date.slice(5), count: item.total })),
    touchedThisWeek: touched.size,
    weeklyGoal: Math.max(tickets.length, touched.size),
    clearedThisWeek: cleared.size,
    clearGoal: Math.max(snapshots[0]?.total ?? tickets.length, cleared.size),
    recent: recentEvent ? { id: recentEvent.key.slice(provider.length + 1), title: recentTicket?.title ?? `Ticket #${recentEvent.key.slice(provider.length + 1)}`, status: recentTicket?.status, agent: recentEvent.session.agent === 'claude' ? 'Claude' : 'Codex', at: recentEvent.at } : undefined
  };
}

/** Renders a fixed-width proportional bar. */
function bar(value: number, max: number, width = 12): string {
  const fill = max ? Math.round(value / max * width) : 0;
  return `${'█'.repeat(fill)}${'░'.repeat(width - fill)}`;
}
/** Formats a timestamp as a short relative age. */
function ago(value: number, now: number): string {
  const minutes = Math.max(0, Math.floor((now - value) / 60_000));
  if (minutes < 1) return 'just now';
  if (minutes < 60) return `${minutes}m ago`;
  const hours = Math.floor(minutes / 60); return hours < 24 ? `${hours}h ago` : `${Math.floor(hours / 24)}d ago`;
}
/** Renders numeric history as a compact sparkline. */
function spark(values: number[]): string {
  if (!values.length) return 'No history yet';
  const levels = [...'▁▂▃▄▅▆▇█']; const max = Math.max(...values, 1);
  return values.map(value => levels[Math.round(value / max * (levels.length - 1))]).join(' ');
}
/** Pads or truncates text to a fixed character width. */
function fit(value: string, width: number): string {
  const chars = [...value];
  return chars.length > width ? `${chars.slice(0, Math.max(0, width - 1)).join('')}…` : value.padEnd(width);
}
export interface DashboardPalette {
  /** Styles section headings. */
  heading(value: string): string;
  /** Styles positive values. */
  positive(value: string): string;
  /** Styles warning values. */
  warning(value: string): string;
  /** Styles dangerous values. */
  danger(value: string): string;
  /** Styles accent values. */
  accent(value: string): string;
  /** Styles emphasized values. */
  bold(value: string): string;
}
const defaultPalette: DashboardPalette = {
  /** Applies the default heading treatment. */
  heading: value => bold(accent(value)),
  positive: good,
  warning,
  danger,
  accent,
  bold
};
/** Adds unstyled padding after a pre-styled dashboard cell. */
function styledCell(raw: string, styled: string, width: number): string {
  return `${styled}${' '.repeat(Math.max(0, width - [...raw].length))}`;
}
/** Renders a complete terminal dashboard from aggregated local statistics. */
export function renderDashboard(model: DashboardModel, columns = process.stdout.columns ?? 80, now = Date.now(), palette: DashboardPalette = defaultPalette): string {
  const statusMax = Math.max(...model.statuses.map(([, count]) => count), 1);
  const agentMax = Math.max(model.agents.claude, model.agents.codex, 1);
  const width = Math.max(4, Math.min(8, Math.floor(columns / 10)));
  const half = Math.max(30, Math.floor((columns - 5) / 2));
  const statusCells = model.statuses.length ? model.statuses.map(([name, count]) => {
    const chart = bar(count, statusMax, width);
    const number = String(count).padStart(2);
    return {
      raw: `${fit(name, 14)} ${chart} ${number}`,
      styled: `${fit(name, 14)} ${palette.accent(chart)} ${palette.bold(number)}`
    };
  }) : [{ raw: 'No cached tickets yet', styled: 'No cached tickets yet' }];
  const statusRows: string[] = [];
  for (let index = 0; index < statusCells.length; index += 2) {
    const first = statusCells[index]!;
    statusRows.push(`  ${styledCell(first.raw, first.styled, half)} ${statusCells[index + 1]?.styled ?? ''}`.trimEnd());
  }
  const trendGraph = spark(model.trend.map(item => item.count));
  const trend = `${palette.accent(trendGraph)}${model.trend.length ? `  ${model.trend.map(item => item.label).join(' ')}` : ''}`;
  const recentMeta = model.recent ? ` · ${model.recent.status ?? 'Status unavailable'} · ${model.recent.agent} · ${ago(model.recent.at, now)}` : '';
  const recent = model.recent
    ? `${palette.accent(`#${model.recent.id}`)}  ${palette.bold(fit(model.recent.title, Math.max(10, columns - recentMeta.length - model.recent.id.length - 7)).trimEnd())}${recentMeta}`
    : 'No agent activity yet';
  const claudeRaw = `Claude  ${bar(model.agents.claude, agentMax, width)} ${model.agents.claude}`;
  const codexRaw = `Codex   ${bar(model.agents.codex, agentMax, width)} ${model.agents.codex}`;
  const claudeStyled = `Claude  ${palette.accent(bar(model.agents.claude, agentMax, width))} ${palette.bold(String(model.agents.claude))}`;
  const codexStyled = `Codex   ${palette.accent(bar(model.agents.codex, agentMax, width))} ${palette.bold(String(model.agents.codex))}`;
  const activityGraph = spark(model.activity.map(item => item.count));
  const questMessage = model.open === 0
    ? palette.positive('(˶ᵔ ᵕ ᵔ˶)  Quest board clear!')
    : model.clearedThisWeek
      ? palette.positive(`( •̀ᴗ•́)⚔  ${model.clearedThisWeek} quest${model.clearedThisWeek === 1 ? '' : 's'} cleared this week!`)
      : palette.warning(`( •̀ᴗ•́)✧  ${model.open} quest${model.open === 1 ? '' : 's'} await you!`);
  const lines = [
    `  ⚔  Open ${palette.warning(String(model.open))}   🐞 Bugs ${palette.danger(String(model.bugs))}   📜 Stories ${palette.accent(String(model.stories))}   ✦ Sessions ${palette.positive(String(model.sessions))}   ↻ ${model.refreshedAt ? ago(model.refreshedAt, now) : 'never'}`,
    `  ▶  ${palette.positive(String(model.resumable))} ticket${model.resumable === 1 ? '' : 's'} ready to resume`,
    '', `  ${palette.heading('QUEST STATUS')}`,
    ...statusRows,
    '', `  ${palette.heading(fit('AGENT PARTY', half))} ${palette.heading('WEEKLY QUESTS')}`,
    `  ${styledCell(claudeRaw, claudeStyled, half)} Touched  [${palette.accent(bar(model.touchedThisWeek, model.weeklyGoal, width))}] ${palette.positive(`${model.touchedThisWeek}/${model.weeklyGoal}`)}`,
    `  ${styledCell(codexRaw, codexStyled, half)} Cleared  [${palette.accent(bar(model.clearedThisWeek, model.clearGoal, width))}] ${palette.positive(`${model.clearedThisWeek}/${model.clearGoal}`)} from board`,
    '', `  ${palette.heading(fit('7-DAY ACTIVITY', half))} ${palette.heading('OPEN QUEST TREND')}`,
    `  ${styledCell(model.activity.map(item => item.label).join('  '), model.activity.map(item => item.label).join('  '), half)} ${trend}`,
    `  ${palette.accent(activityGraph)}`,
    '', `  ${palette.heading('LAST QUEST')}`,
    `  ${recent}`,
    '', `  ${questMessage}`
  ];
  return lines.join('\n');
}
