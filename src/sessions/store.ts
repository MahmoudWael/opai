import { mkdir, readFile, rename, writeFile } from 'node:fs/promises';
import { dirname, join } from 'node:path';
import { randomUUID } from 'node:crypto';
import { configDir } from '../config.js';
import { ticketKey, type Ticket } from '../providers/types.js';
export interface Session { agent: 'claude' | 'codex'; sessionId: string; cwd: string; model?: string | null; effort?: string | null; initialPrompt?: string | null; createdAt: string; lastUsedAt?: string; usedAt?: string[]; ticket?: Ticket }
export type Registry = Record<string, Session[]>;
export interface TicketSessions { key: string; id: string; title: string; status?: string; sessions: Session[]; lastUsedAt: string }
/** Groups registered native sessions by ticket and sorts them by recent use. */
export function sessionTickets(registry: Registry, provider: string): TicketSessions[] {
  return Object.entries(registry).filter(([key, sessions]) => key.startsWith(`${provider}:`) && sessions.length > 0).map(([key, sessions]) => {
    const ordered = [...sessions].sort((a, b) => Date.parse(b.lastUsedAt ?? b.createdAt) - Date.parse(a.lastUsedAt ?? a.createdAt));
    const id = key.slice(provider.length + 1);
    const snapshot = [...sessions].sort((a, b) => Date.parse(b.createdAt) - Date.parse(a.createdAt)).find(session => session.ticket)?.ticket;
    return { key, id, title: snapshot?.title ?? `Ticket #${id}`, status: snapshot?.status, sessions: ordered, lastUsedAt: ordered[0].lastUsedAt ?? ordered[0].createdAt };
  }).sort((a, b) => Date.parse(b.lastUsedAt) - Date.parse(a.lastUsedAt));
}
export class SessionStore {
  /** Creates a session registry backed by the supplied JSON file. */
  constructor(readonly path = join(configDir, 'sessions.json')) {}
  /** Loads and validates the complete native-session registry. */
  async all(): Promise<Registry> {
    try { const value: unknown = JSON.parse(await readFile(this.path, 'utf8')); if (!value || typeof value !== 'object' || Array.isArray(value)) throw new Error('Invalid session registry.'); return value as Registry; }
    catch (error) { if ((error as NodeJS.ErrnoException).code === 'ENOENT') return {}; throw error; }
  }
  /** Lists sessions for a ticket with backward-compatible launch metadata. */
  async list(key: string): Promise<Session[]> { return ((await this.all())[key] ?? []).map(session => ({ ...session, model: session.model ?? null, effort: session.effort ?? null, initialPrompt: session.initialPrompt ?? null })); }
  /** Updates ticket snapshots stored beside existing native session records. */
  async syncTickets(tickets: Ticket[]): Promise<number> {
    const data = await this.all();
    let updated = 0;
    for (const ticket of tickets) {
      for (const session of data[ticketKey(ticket)] ?? []) {
        if (JSON.stringify(session.ticket) === JSON.stringify(ticket)) continue;
        session.ticket = ticket;
        updated++;
      }
    }
    if (updated) await this.save(data);
    return updated;
  }
  /** Atomically persists the complete native-session registry. */
  private async save(data: Registry): Promise<void> {
    await mkdir(dirname(this.path), { recursive: true, mode: 0o700 });
    const temp = `${this.path}.${randomUUID()}.tmp`;
    await writeFile(temp, JSON.stringify(data, null, 2) + '\n', { mode: 0o600 });
    await rename(temp, this.path);
  }
  /** Validates and adds a verified native session without replacing older ones. */
  async add(key: string, session: Session): Promise<void> {
    if (!key.includes(':') || !/^[0-9a-f-]{36}$/i.test(session.sessionId) || !session.cwd || !Number.isFinite(Date.parse(session.createdAt))) throw new Error('Invalid session record.');
    const data = await this.all();
    data[key] ??= [];
    if (!data[key].some(item => item.agent === session.agent && item.sessionId === session.sessionId)) data[key].push({ ...session, usedAt: session.usedAt ?? [session.createdAt] });
    await this.save(data);
  }
  /** Records a successful use of an existing ticket session. */
  async touch(key: string, sessionId: string): Promise<void> {
    const data = await this.all();
    const session = data[key]?.find(item => item.sessionId === sessionId);
    if (!session) throw new Error('Session is not registered for this ticket.');
    session.lastUsedAt = new Date().toISOString();
    session.usedAt = [...(session.usedAt ?? [session.createdAt]), session.lastUsedAt];
    await this.save(data);
  }
}
