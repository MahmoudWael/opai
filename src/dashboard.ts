import { mkdir, readFile, rename, writeFile } from 'node:fs/promises';
import { dirname, join } from 'node:path';
import { randomUUID } from 'node:crypto';
import { configDir } from './config.js';
import type { Ticket } from './providers/types.js';
import type { Registry, Session } from './sessions/store.js';

export interface DailySnapshot { date: string; refreshedAt: number; ticketIds: string[]; total: number }
type History = Record<string, DailySnapshot[]>;

function dayKey(value: Date): string {
  return `${value.getFullYear()}-${String(value.getMonth() + 1).padStart(2, '0')}-${String(value.getDate()).padStart(2, '0')}`;
}
function validHistory(value: unknown): value is History {
  return Boolean(value) && typeof value === 'object' && !Array.isArray(value);
}
export class DashboardHistoryStore {
  private writable = true;
  constructor(readonly path = join(configDir, 'dashboard-history.json')) {}
  private async all(): Promise<History> {
    try { const value: unknown = JSON.parse(await readFile(this.path, 'utf8')); return validHistory(value) ? value : {}; }
    catch { return {}; }
  }
  private async save(value: History): Promise<void> {
    await mkdir(dirname(this.path), { recursive: true, mode: 0o700 });
    const temp = `${this.path}.${randomUUID()}.tmp`;
    await writeFile(temp, `${JSON.stringify(value, null, 2)}\n`, { mode: 0o600 });
    await rename(temp, this.path);
  }
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
  async list(provider: string): Promise<DailySnapshot[]> { return (await this.all())[provider] ?? []; }
}

export interface DashboardModel {
  open: number; bugs: number; stories: number; sessions: number; resumable: number;
  refreshedAt?: number; statuses: [string, number][]; agents: { claude: number; codex: number };
  activity: { label: string; count: number }[]; trend: { label: string; count: number }[];
  touchedThisWeek: number; weeklyGoal: number; clearedThisWeek: number; clearGoal: number;
  recent?: { id: string; title: string; status?: string; agent: string; at: number };
}
function activityTimes(session: Session): number[] {
  const values = session.usedAt?.length ? session.usedAt : [session.createdAt, session.lastUsedAt].filter((value): value is string => Boolean(value));
  return [...new Set(values)].map(Date.parse).filter(Number.isFinite);
}
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

function bar(value: number, max: number, width = 12): string {
  const fill = max ? Math.round(value / max * width) : 0;
  return `${'█'.repeat(fill)}${'░'.repeat(width - fill)}`;
}
function ago(value: number, now: number): string {
  const minutes = Math.max(0, Math.floor((now - value) / 60_000));
  if (minutes < 1) return 'just now';
  if (minutes < 60) return `${minutes}m ago`;
  const hours = Math.floor(minutes / 60); return hours < 24 ? `${hours}h ago` : `${Math.floor(hours / 24)}d ago`;
}
function spark(values: number[]): string {
  if (!values.length) return 'No history yet';
  const levels = [...'▁▂▃▄▅▆▇█']; const max = Math.max(...values, 1);
  return values.map(value => levels[Math.round(value / max * (levels.length - 1))]).join(' ');
}
function fit(value: string, width: number): string {
  const chars = [...value];
  return chars.length > width ? `${chars.slice(0, Math.max(0, width - 1)).join('')}…` : value.padEnd(width);
}
export function renderDashboard(model: DashboardModel, columns = process.stdout.columns ?? 80, now = Date.now()): string {
  const statusMax = Math.max(...model.statuses.map(([, count]) => count), 1);
  const agentMax = Math.max(model.agents.claude, model.agents.codex, 1);
  const width = Math.max(4, Math.min(8, Math.floor(columns / 10)));
  const half = Math.max(30, Math.floor((columns - 5) / 2));
  const statusCells = model.statuses.length ? model.statuses.map(([name, count]) => `${fit(name, 14)} ${bar(count, statusMax, width)} ${String(count).padStart(2)}`) : ['No cached tickets yet'];
  const statusRows: string[] = [];
  for (let index = 0; index < statusCells.length; index += 2) statusRows.push(`  ${fit(statusCells[index], half)} ${statusCells[index + 1] ?? ''}`.trimEnd());
  const trend = `${spark(model.trend.map(item => item.count))}${model.trend.length ? `  ${model.trend.map(item => item.label).join(' ')}` : ''}`;
  const recentMeta = model.recent ? ` · ${model.recent.status ?? 'Status unavailable'} · ${model.recent.agent} · ${ago(model.recent.at, now)}` : '';
  const recent = model.recent ? `#${model.recent.id}  ${fit(model.recent.title, Math.max(10, columns - recentMeta.length - model.recent.id.length - 7)).trimEnd()}${recentMeta}` : 'No agent activity yet';
  const lines = [
    `  ⚔  Open ${model.open}   🐞 Bugs ${model.bugs}   📜 Stories ${model.stories}   ✦ Sessions ${model.sessions}   ↻ ${model.refreshedAt ? ago(model.refreshedAt, now) : 'never'}`,
    `  ⛨  ${model.resumable} ticket${model.resumable === 1 ? '' : 's'} ready to resume`,
    '', '  QUEST STATUS',
    ...statusRows,
    '', `  ${fit('AGENT PARTY', half)} WEEKLY QUESTS`,
    `  ${fit(`Claude  ${bar(model.agents.claude, agentMax, width)} ${model.agents.claude}`, half)} Touched  [${bar(model.touchedThisWeek, model.weeklyGoal, width)}] ${model.touchedThisWeek}/${model.weeklyGoal}`,
    `  ${fit(`Codex   ${bar(model.agents.codex, agentMax, width)} ${model.agents.codex}`, half)} Cleared  [${bar(model.clearedThisWeek, model.clearGoal, width)}] ${model.clearedThisWeek}/${model.clearGoal} from board`,
    '', `  ${fit('7-DAY ACTIVITY', half)} OPEN QUEST TREND`,
    `  ${fit(model.activity.map(item => item.label).join('  '), half)} ${trend}`,
    `  ${spark(model.activity.map(item => item.count))}`,
    '', '  LAST QUEST',
    `  ${recent}`,
    '', `  ${model.open === 0 ? '(˶ᵔ ᵕ ᵔ˶)  Quest board clear!' : model.clearedThisWeek ? `( •̀ᴗ•́)⚔  ${model.clearedThisWeek} quest${model.clearedThisWeek === 1 ? '' : 's'} cleared this week!` : `( •̀ᴗ•́)✧  ${model.open} quest${model.open === 1 ? '' : 's'} await you!`}`
  ];
  return lines.join('\n');
}
