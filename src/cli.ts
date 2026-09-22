#!/usr/bin/env node
import { createHash, randomUUID } from 'node:crypto';
import { stat } from 'node:fs/promises';
import { password, select, search } from '@inquirer/prompts';
import { loadConfig } from './config.js';
import { OpenProjectProvider } from './providers/openproject.js';
import { ticketKey, type SavedQuery, type Ticket, type TicketProvider } from './providers/types.js';
import { ListCache, isSavedQueryList, isTicketList } from './list-cache.js';
import { loadApiToken, saveApiToken, tokenPath } from './token.js';
import { SessionStore, sessionTickets, type Session } from './sessions/store.js';
import { syncSessionTickets } from './sessions/sync.js';
import { QueryPreferencesStore, orderedQueries } from './query-preferences.js';
import { claudeLaunch, claudeResume, findClaudeTicketSessions, nativeClaudeSessionExists } from './agents/claude.js';
import { codexLaunch, codexResume, codexSessionFiles, findCodexTicketSessions, identifyCodexSession, nativeCodexSessionExists } from './agents/codex.js';
import { runAgent } from './agents/run.js';
import type { Agent } from './agents/types.js';
import { goodbye, hint, listHighlight, muted, screen, sessionRow, ticketRow, warning } from './ui.js';
import { statusBar } from './status.js';
import { BACK, promptWithBack } from './back.js';
import { DashboardHistoryStore, buildDashboard, renderDashboard } from './dashboard.js';
function aborted(error: unknown): boolean { return error instanceof Error && error.name === 'ExitPromptError'; }
const listTheme = { style: { highlight: listHighlight, keysHelpTip: (keys: [key: string, action: string][]) => `${keys.map(([key, action]) => `${key} ${action}`).join(' · ')} · Esc back` } };
async function directoryExists(path: string): Promise<boolean> { try { return (await stat(path)).isDirectory(); } catch { return false; } }
async function nativeExists(session: Session): Promise<boolean> {
  if (session.agent === 'codex') return nativeCodexSessionExists(session.sessionId);
  return nativeClaudeSessionExists(session.sessionId);
}
async function main(): Promise<void> {
  const config = await loadConfig();
  let apiToken = await loadApiToken();
  if (!apiToken) {
    if (!process.stdin.isTTY) throw new Error(`No OpenProject API token found. Run opai in a terminal to save one, or set OPENPROJECT_API_TOKEN.`);
    screen('Connect OpenProject', 'One-time setup · token is saved locally with owner-only access');
    apiToken = await password({ message: 'OpenProject API token', mask: '*' });
    if (!apiToken.trim()) throw new Error('API token cannot be empty.');
    await saveApiToken(apiToken);
    console.log(`Saved token to ${tokenPath}.`);
  }
  const provider: TicketProvider = new OpenProjectProvider(config.openproject, apiToken);
  const store = new SessionStore();
  const dashboardHistory = new DashboardHistoryStore();
  const queryPreferences = new QueryPreferencesStore();
  const namespace = createHash('sha256').update(JSON.stringify([provider.identity, config.openproject.url, config.openproject.bugTypeId, config.openproject.userStoryTypeId, apiToken])).digest('hex');
  const cacheTtlMs = (config.cacheTtlHours ?? 8) * 60 * 60 * 1000;
  const ticketCache = new ListCache<Ticket[]>(namespace, cacheTtlMs, isTicketList);
  const queryCache = new ListCache<SavedQuery[]>(namespace, cacheTtlMs, isSavedQueryList);
  async function cachedList<T extends unknown[]>(cache: ListCache<T>, key: string, load: () => Promise<T>, label: string, noun: string, refresh = false): Promise<T> {
    let fetched = false;
    const value = await cache.get(key, () => {
      fetched = true;
      return statusBar.run(`Loading ${label}`, load, items => `${items.length} ${noun} loaded`);
    }, refresh);
    if (!fetched) statusBar.set('cached', `${value.length} ${noun} from cache`);
    return value;
  }
  async function cachedTickets(key: string, load: () => Promise<Ticket[]>, label: string, refresh = false, includeMissing = false): Promise<Ticket[]> {
    let unavailable: string[] = [];
    const tickets = await cachedList(ticketCache, key, async () => {
      const fresh = await load();
      unavailable = (await syncSessionTickets(store, provider, fresh, includeMissing)).unavailable;
      if (key === 'mine') await dashboardHistory.record(provider.identity, fresh);
      return fresh;
    }, label, 'tickets', refresh);
    if (unavailable.length) console.warn(`Could not refresh saved status for ticket${unavailable.length === 1 ? '' : 's'} ${unavailable.map(id => `#${id}`).join(', ')}.`);
    return tickets;
  }
  const cwd = config.cwd ?? process.cwd();
  if (!await directoryExists(cwd)) throw new Error(`Working directory does not exist: ${cwd}`);
  const executables = { claude: config.agents?.claude ?? 'claude', codex: config.agents?.codex ?? 'codex' };
  async function launch(ticket: Ticket, agent: Agent): Promise<void> {
    const prompt = provider.prompt(ticket, ticket.type === 'Bug' ? 'fix' : 'implement');
    const id: string | undefined = agent === 'claude' ? randomUUID() : undefined;
    const before = agent === 'codex' ? await codexSessionFiles() : undefined;
    const started = new Date().toISOString();
    const spec = agent === 'claude' ? claudeLaunch(executables.claude, cwd, prompt, id!) : codexLaunch(executables.codex, cwd, prompt);
    let savedId: string | undefined;
    const record = async () => {
      if (savedId) return;
      const sessionId = agent === 'claude' ? id : await identifyCodexSession(before!, await codexSessionFiles(), cwd, prompt);
      if (!sessionId || !await nativeExists({ agent, sessionId, cwd, createdAt: started })) return;
      await store.add(ticketKey(ticket), { agent, sessionId, cwd, createdAt: started, lastUsedAt: new Date().toISOString(), ticket });
      savedId = sessionId;
    };
    const code = await runAgent(spec, record);
    await record();
    if (savedId) console.log(`Saved ${agent} session ${savedId} for #${ticket.id}.`);
    else console.log(`No verified ${agent} session ID was found; no association saved.`);
    if (code !== 0) console.log(`${agent} exited with code ${code}.`);
  }
  async function recover(ticket: Ticket): Promise<void> {
    const prompt = provider.prompt(ticket, ticket.type === 'Bug' ? 'fix' : 'implement');
    screen(`#${ticket.id}  Find native session`, 'Sessions whose first user prompt exactly matches this ticket');
    const candidates = [...await findClaudeTicketSessions(prompt), ...await findCodexTicketSessions(prompt)];
    const available = (await Promise.all(candidates.map(async candidate => await directoryExists(candidate.cwd) ? candidate : undefined)))
      .filter((candidate): candidate is (typeof candidates)[number] => candidate !== undefined);
    const existing = await store.list(ticketKey(ticket));
    const matches = available.filter(candidate => !existing.some(session => session.agent === candidate.agent && session.sessionId === candidate.sessionId));
    if (!matches.length) { console.log('No unrecorded native session with this exact ticket prompt was found.'); return; }
    const index = await promptWithBack(signal => select({ message: 'Record a session for this ticket', pageSize: 12, theme: listTheme, choices: matches.map((candidate, index) => ({ name: `${candidate.agent === 'claude' ? 'Claude Code' : 'Codex'} · ${new Date(candidate.createdAt).toLocaleString()} · ${candidate.cwd}`, value: index })) }, { signal }));
    if (index === BACK) return;
    const candidate = matches[index]!;
    if (!await directoryExists(candidate.cwd) || !await nativeExists(candidate)) { console.log('Native session or working directory is no longer available.'); return; }
    await store.add(ticketKey(ticket), { ...candidate, lastUsedAt: candidate.createdAt, ticket });
    console.log(`Recorded ${candidate.agent} session ${candidate.sessionId} for #${ticket.id}.`);
  }
  async function resumeForKey(key: string, title: string, confirmSingle = false): Promise<void> {
    const sessions = await store.list(key);
    if (!sessions.length) { console.log('No session recorded for this ticket.'); return; }
    if (sessions.length > 1 || confirmSingle) screen(title, 'Choose a saved conversation');
    const index = sessions.length === 1 && !confirmSingle ? 0 : await promptWithBack(signal => select({ message: 'Resume session', pageSize: 12, theme: listTheme, choices: sessions.map((s, index) => ({ name: `${s.agent === 'claude' ? 'Claude Code' : 'Codex'} · ${new Date(s.lastUsedAt ?? s.createdAt).toLocaleString()} · ${s.cwd}`, value: index })) }, { signal }));
    const session = index === BACK ? undefined : sessions[index];
    if (!session) return;
    if (!await directoryExists(session.cwd)) { console.log(`Working directory no longer exists: ${session.cwd}`); return; }
    if (!await nativeExists(session)) { console.log(`Native ${session.agent} session ${session.sessionId} is missing or inaccessible.`); return; }
    const spec = session.agent === 'claude' ? claudeResume(executables.claude, session.cwd, session.sessionId) : codexResume(executables.codex, session.cwd, session.sessionId);
    const code = await runAgent(spec);
    if (code === 0 || code === 130) await store.touch(key, session.sessionId);
    else console.log(`Resume exited with code ${code}; no new session was created by OPAI.`);
  }
  async function ticketMenu(ticket: Ticket): Promise<void> {
    while (true) {
      screen(`#${ticket.id}  ${ticket.title}`, `${ticket.typeLabel} · ${ticket.status}${ticket.url ? ` · ${ticket.url}` : ''}`);
      const sessions = await store.list(ticketKey(ticket));
      const action = ticket.type === 'Bug' ? 'Fix' : 'Implement';
      const choices = ticket.type === 'Unsupported' ? [] : [
        { name: `${action} with Claude Code`, value: 'claude', description: 'Start a new native Claude session' },
        { name: `${action} with Codex`, value: 'codex', description: 'Start a new native Codex session' }
      ];
      if (ticket.type === 'Unsupported') console.log(`  ${warning('No action mapped for this ticket type.')} ${muted('Set its type ID in config.json to enable it.')}\n`);
      console.log(`  ${muted('↑↓ move · Enter select · Esc back · Ctrl+C exit')}\n`);
      const choice = await promptWithBack(signal => select({ message: 'Choose an action', pageSize: 8, theme: listTheme, choices: [...choices, ...(sessions.length ? [{ name: `Resume saved session${sessions.length > 1 ? `s (${sessions.length})` : ''}`, value: 'resume' }] : []), ...(ticket.type !== 'Unsupported' ? [{ name: 'Find existing native session', value: 'recover' }] : [])] }, { signal }));
      if (choice === BACK) return;
      try { if (choice === 'resume') await resumeForKey(ticketKey(ticket), `#${ticket.id} ${ticket.title}`); else if (choice === 'recover') await recover(ticket); else await launch(ticket, choice as Agent); }
      catch (error) { console.error(error instanceof Error ? error.message : String(error)); }
    }
  }
  const args = process.argv.slice(2);
  if (args.length && args[0] !== 'mine' && args[0] !== 'show' && args[0] !== 'resume') throw new Error('Usage: opai [mine | show <id> | resume <id>]');
  if (args[0] === 'show' || args[0] === 'resume') {
    if (!args[1]) throw new Error('Ticket ID required.');
    if (args[0] === 'resume') { await resumeForKey(`${provider.identity}:${args[1]}`, `Ticket #${args[1]}`, true); return; }
    const ticket = await statusBar.run(`Loading ticket #${args[1]}`, () => provider.get(args[1]), item => `Ticket #${item.id} loaded`);
    await ticketMenu(ticket);
    return;
  }
  async function browseTickets(key: string, label: string, load: () => Promise<Ticket[]>): Promise<void> {
    const tickets = await cachedTickets(key, load, label);
    while (true) {
      screen(label, `${tickets.length} ticket${tickets.length === 1 ? '' : 's'} · auto refresh after ${config.cacheTtlHours ?? 8}h`);
      if (!tickets.length) console.log(`  ${muted('No tickets in this list.')}\n`);
      console.log(`  ${hint()}\n`);
      const selected = await promptWithBack(signal => search<Ticket>({ message: 'Search by ID or title', pageSize: 12, theme: listTheme, source: async term => {
        const filtered = tickets.filter(ticket => `${ticket.id} ${ticket.title} ${ticket.typeLabel}`.toLowerCase().includes((term ?? '').toLowerCase()));
        return filtered.map(ticket => ({ name: ticketRow(ticket), value: ticket, short: `#${ticket.id} ${ticket.title}` }));
      } }, { signal }));
      if (selected === BACK) return;
      await ticketMenu(selected);
    }
  }
  async function queryMenu(query: SavedQuery): Promise<void> {
    const key = `query:${query.id}`;
    const load = () => provider.listQueryTickets(query.id);
    while (true) {
      screen(query.name, 'Saved query · ticket results load on first open');
      const pinned = Boolean((await queryPreferences.all())[`${provider.identity}:${query.id}`]?.pinned);
      const choice = await promptWithBack(signal => select({ message: 'What would you like to do?', theme: listTheme, choices: [
        { name: 'Browse tickets', value: 'browse' },
        { name: '↻  Refresh query results', value: 'refresh' },
        { name: pinned ? '★  Unpin query' : '☆  Pin query', value: 'pin' }
      ] }, { signal }));
      if (choice === BACK) return;
      try {
        if (choice === 'pin') {
          const next = await queryPreferences.togglePin(provider.identity, query.id);
          statusBar.set('success', next ? 'Query pinned' : 'Query unpinned');
        } else if (choice === 'refresh') {
          await cachedTickets(key, load, query.name, true);
        } else await browseTickets(key, query.name, load);
      } catch (error) { console.error(error instanceof Error ? error.message : String(error)); }
    }
  }
  async function savedQueries(): Promise<void> {
    const queries = await cachedList(queryCache, 'saved', () => provider.listSavedQueries(), 'saved queries', 'queries');
    while (true) {
      screen('Saved queries', `${queries.length} quer${queries.length === 1 ? 'y' : 'ies'} · auto refresh after ${config.cacheTtlHours ?? 8}h`);
      console.log(`  ${muted('Type to search · ↑↓ move · Enter select · Esc back')}\n`);
      const preferences = await queryPreferences.all();
      const sorted = orderedQueries(queries, preferences, provider.identity);
      const choice = await promptWithBack(signal => search<SavedQuery>({ message: 'Search saved queries', pageSize: 12, theme: listTheme, source: async term => {
        const filtered = sorted.filter(query => `${query.id} ${query.name}`.toLowerCase().includes((term ?? '').toLowerCase()));
        return filtered.map(query => {
          const preference = preferences[`${provider.identity}:${query.id}`];
          const marker = preference?.pinned ? '★' : preference?.lastOpenedAt ? '◷' : '▤';
          return { name: `${marker}  ${query.name}`, value: query, short: query.name };
        });
      } }, { signal }));
      if (choice === BACK) return;
      const query = choice;
      await queryPreferences.opened(provider.identity, query.id);
      await queryMenu(query);
    }
  }
  async function mySessions(): Promise<void> {
    while (true) {
      const groups = sessionTickets(await store.all(), provider.identity);
      screen('My sessions', `${groups.length} ticket${groups.length === 1 ? '' : 's'} with saved conversations · local only`);
      if (!groups.length) console.log(`  ${muted('No saved sessions yet. Launch an agent from a ticket first.')}\n`);
      console.log(`  ${muted('Type a ticket ID or title · Esc back')}\n`);
      const choice = await promptWithBack(signal => search<(typeof groups)[number]>({ message: 'Search saved sessions', pageSize: 12, theme: listTheme, source: async term => {
        const filtered = groups.filter(group => `${group.id} ${group.title}`.toLowerCase().includes((term ?? '').toLowerCase()));
        return filtered.map(group => ({ name: sessionRow(group), value: group, short: `#${group.id} ${group.title}` }));
      } }, { signal }));
      if (choice === BACK) return;
      const group = choice;
      await resumeForKey(group.key, `#${group.id} ${group.title}`, true);
    }
  }
  if (args[0] === 'mine') { await browseTickets('mine', 'My tickets', () => provider.listAssigned()); return; }
  while (true) {
    screen('Home', `Browse tickets or saved queries · cache expires after ${config.cacheTtlHours ?? 8}h`);
    const cachedMine = await ticketCache.peek('mine');
    if (cachedMine) await dashboardHistory.record(provider.identity, cachedMine.value, new Date(cachedMine.fetchedAt));
    const dashboard = buildDashboard(cachedMine?.value ?? [], cachedMine?.fetchedAt, await store.all(), provider.identity, await dashboardHistory.list(provider.identity));
    console.log(`${renderDashboard(dashboard)}\n`);
    const choice = await promptWithBack(signal => select({ message: 'Choose a view', choices: [
      { name: 'My tickets', value: 'mine' },
      { name: 'Saved queries', value: 'queries' },
      { name: 'My sessions', value: 'sessions' },
      { name: '↻  Refresh my tickets', value: 'refresh-mine' },
      { name: '↻  Refresh saved queries', value: 'refresh-queries' },
      { name: '×  Exit OPAI', value: 'exit' }
    ] }, { signal }));
    if (choice === 'exit' || choice === BACK) return;
    try {
      if (choice === 'mine') await browseTickets('mine', 'My tickets', () => provider.listAssigned());
      else if (choice === 'queries') await savedQueries();
      else if (choice === 'sessions') await mySessions();
      else if (choice === 'refresh-mine') {
        await cachedTickets('mine', () => provider.listAssigned(), 'my tickets', true, true);
      } else {
        await cachedList(queryCache, 'saved', () => provider.listSavedQueries(), 'saved queries', 'queries', true);
      }
    } catch (error) { console.error(error instanceof Error ? error.message : String(error)); }
  }
}
main().then(goodbye).catch(error => {
  if (aborted(error)) goodbye();
  else { console.error(error instanceof Error ? error.message : String(error)); process.exitCode = 1; }
});
