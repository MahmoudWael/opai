#!/usr/bin/env node
import { createHash, randomUUID } from 'node:crypto';
import { stat } from 'node:fs/promises';
import { input, password, select, search, Separator } from '@inquirer/prompts';
import { loadConfig } from './config.js';
import { OpenProjectProvider } from './providers/openproject.js';
import { ticketKey, type PromptKind, type SavedQuery, type Ticket, type TicketProvider } from './providers/types.js';
import { ListCache, isSavedQueryList, isTicketList } from './list-cache.js';
import { loadApiToken, saveApiToken, tokenPath } from './token.js';
import { SessionStore, sessionTickets, type Session } from './sessions/store.js';
import { syncSessionTickets } from './sessions/sync.js';
import { QueryPreferencesStore, querySections } from './query-preferences.js';
import { claudeLaunch, claudeResume, findClaudeTicketSessions, nativeClaudeSessionExists } from './agents/claude.js';
import { codexLaunch, codexResume, codexSessionFiles, findCodexTicketSessions, identifyCodexSession, nativeCodexSessionExists } from './agents/codex.js';
import { runAgent } from './agents/run.js';
import type { Agent } from './agents/types.js';
import { accent, agentClosedScreen, bold, centeredMenuChoices, goodbye, good, hint, listHighlight, muted, screen, selectionCursor, sessionRow, setIdleMascotMood, ticketRow, warning } from './ui.js';
import { statusBar } from './status.js';
import { BACK, promptWithBack } from './back.js';
import { DashboardHistoryStore, buildDashboard, renderDashboard } from './dashboard.js';
import { LaunchPreferenceStore, type AgentLaunchDefaults } from './launch-preferences.js';
import { modelLabel, resolvePreferredModel, type ModelPreference } from './models.js';
import { availableEfforts, discoverAgentCapabilities, resolveEffort, type AgentCapabilities } from './agents/capabilities.js';
import { buildLaunchMenu, editablePromptConfig, launchDefaultsRow, launchDefaultsSummary, menuSectionHeader, promptDefaultsSummary, type LaunchAction } from './launch-menu.js';
import { MascotRotationStore } from './ui-state.js';
function aborted(error: unknown): boolean { return error instanceof Error && error.name === 'ExitPromptError'; }
class ExitToTerminal extends Error {}
const menuTheme = { icon: { cursor: selectionCursor() }, style: { highlight: accent } };
const listTheme = { ...menuTheme, style: { ...menuTheme.style, highlight: listHighlight, keysHelpTip: (keys: [key: string, action: string][]) => `${keys.map(([key, action]) => `${key} ${action}`).join(' · ')} · Esc back` } };
async function directoryExists(path: string): Promise<boolean> { try { return (await stat(path)).isDirectory(); } catch { return false; } }
async function nativeExists(session: Session): Promise<boolean> {
  if (session.agent === 'codex') return nativeCodexSessionExists(session.sessionId);
  return nativeClaudeSessionExists(session.sessionId);
}
async function main(): Promise<void> {
  const config = await loadConfig();
  setIdleMascotMood(await new MascotRotationStore().next());
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
  const launchPreferences = new LaunchPreferenceStore();
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
  const configuredModels: Record<Agent, string[]> = { claude: config.models?.claude ?? [], codex: config.models?.codex ?? [] };
  const capabilityCache: Partial<Record<Agent, Promise<AgentCapabilities>>> = {};
  const agentName = (agent: Agent) => agent === 'claude' ? 'Claude Code' : 'Codex';
  const promptKind = (ticket: Ticket): PromptKind => ticket.type === 'Bug' ? 'bug' : 'userStory';
  const ticketAction = (ticket: Ticket) => ticket.type === 'Bug' ? 'fix' as const : 'implement' as const;
  const effortLabel = (effort: string | null) => effort === null ? 'Default' : effort[0]!.toUpperCase() + effort.slice(1);
  async function afterAgentClosed(detail: string, failed = false): Promise<void> {
    agentClosedScreen(detail, failed ? 'error' : 'success');
    const [returnLabel, exitLabel, message] = centeredMenuChoices(['↩  Return to OPAI', '×  Exit to terminal', 'What next?']);
    const choice = await promptWithBack(signal => select<'return' | 'exit'>({
      message: message!,
      default: 'return',
      theme: menuTheme,
      choices: [
        { name: returnLabel!, value: 'return' },
        { name: exitLabel!, value: 'exit' }
      ]
    }, { signal }));
    if (choice === 'exit') throw new ExitToTerminal();
  }
  async function capabilities(agent: Agent): Promise<AgentCapabilities> {
    capabilityCache[agent] ??= discoverAgentCapabilities(agent, executables[agent], configuredModels[agent]);
    return capabilityCache[agent]!;
  }
  function modelDisplay(model: ModelPreference, caps?: AgentCapabilities): string {
    if (model === null) return 'Default';
    const found = caps?.models.find(item => item.id === model);
    return found && found.label !== found.id ? `${found.label} · ${found.id}` : found?.label ?? model;
  }
  async function selectModel(agent: Agent, current: ModelPreference, caps: AgentCapabilities): Promise<ModelPreference | typeof BACK> {
    return promptWithBack(signal => select<ModelPreference>({ message: `${agentName(agent)} model`, pageSize: 12, theme: menuTheme, default: current, choices: [
      { name: `${muted('◇  Default')}${current === null ? good(' · current') : ''}`, value: null },
      ...caps.models.map(model => ({ name: `${accent('◈')}  ${bold(modelDisplay(model.id, caps))}${model.id === current ? good(' · current') : ''}`, value: model.id }))
    ] }, { signal }));
  }
  async function selectEffort(agent: Agent, current: string | null, model: ModelPreference, caps: AgentCapabilities): Promise<string | null | typeof BACK> {
    const efforts = availableEfforts(caps, model);
    const agentDefault = model === null ? undefined : caps.models.find(item => item.id === model)?.defaultEffort;
    return promptWithBack(signal => select<string | null>({ message: `${agentName(agent)} effort`, pageSize: 10, theme: menuTheme, default: current, choices: [
      { name: `${muted('◇  Default')}${agentDefault ? muted(` · agent uses ${effortLabel(agentDefault)}`) : ''}${current === null ? good(' · current') : ''}`, value: null },
      ...efforts.map(effort => ({ name: `${warning('✦')}  ${bold(effortLabel(effort))}${effort === current ? good(' · current') : ''}`, value: effort }))
    ] }, { signal }));
  }
  interface LaunchSelection { model: ModelPreference; effort: string | null; template: string }
  async function launchOptions(ticket: Ticket, agent: Agent): Promise<LaunchSelection | undefined> {
    const caps = await capabilities(agent);
    const preferences = await launchPreferences.all();
    const kind = promptKind(ticket);
    let model = preferences.agents[agent].model;
    let effort = preferences.agents[agent].effort;
    let template = preferences.prompts[provider.identity]?.[kind] ?? provider.promptTemplate(kind);
    let focusedAction: LaunchAction = 'start';
    while (true) {
      let preview: string;
      try { preview = provider.prompt(ticket, ticketAction(ticket), template); }
      catch (error) { preview = error instanceof Error ? error.message : String(error); }
      const capsEfforts = availableEfforts(caps, model);
      const modelAvailable = model === null || caps.models.some(item => item.id === model);
      const effortAvailable = effort === null || capsEfforts.includes(effort);
      screen(`Start ${agentName(agent)} · #${ticket.id}`, `${ticket.typeLabel} · ${ticket.title}`, agent);
      console.log(`  ${muted(`Tip: {{id}} becomes ${ticket.id}`)}`);
      console.log(`  ${muted(`Will send: ${preview}`)}\n`);
      const menu = buildLaunchMenu(modelDisplay(model, caps), effortLabel(effort), template, focusedAction, { model: modelAvailable, effort: effortAvailable });
      const choice = await promptWithBack(signal => select<LaunchAction>({ message: 'Launch options', pageSize: 8, theme: menuTheme, ...menu }, { signal }));
      if (choice === BACK) return undefined;
      focusedAction = choice;
      if (choice === 'model') {
        const selected = await selectModel(agent, model, caps);
        if (selected !== BACK) {
          model = selected;
          const validEfforts = availableEfforts(caps, model);
          if (effort !== null && !validEfforts.includes(effort)) {
            effort = null;
            statusBar.set('cached', 'Effort returned to Default for the selected model');
          }
        }
      } else if (choice === 'effort') {
        const selected = await selectEffort(agent, effort, model, caps);
        if (selected !== BACK) effort = selected;
      } else if (choice === 'prompt') {
        const selected = await promptWithBack(signal => input(editablePromptConfig('Initial prompt template', template), { signal }));
        if (selected !== BACK) template = selected;
      } else if (choice === 'reset-prompt') {
        template = provider.promptTemplate(kind);
        statusBar.set('success', `${ticket.typeLabel} prompt restored to configured default`);
      } else if (choice === 'save') {
        resolvePreferredModel(agent, model, caps.models.map(item => item.id));
        resolveEffort(effort, availableEfforts(caps, model));
        provider.prompt(ticket, ticketAction(ticket), template);
        await launchPreferences.setAgent(agent, { model, effort });
        await launchPreferences.setPrompt(provider.identity, kind, template);
        statusBar.set('success', `${agentName(agent)} and ${ticket.typeLabel} defaults saved`);
      } else {
        const resolvedModel = resolvePreferredModel(agent, model, caps.models.map(item => item.id));
        const resolvedEffort = resolveEffort(effort, availableEfforts(caps, model));
        provider.prompt(ticket, ticketAction(ticket), template);
        return { model: resolvedModel, effort: resolvedEffort, template };
      }
    }
  }
  async function launch(ticket: Ticket, agent: Agent, selection: LaunchSelection): Promise<void> {
    const prompt = provider.prompt(ticket, ticketAction(ticket), selection.template);
    const { model, effort } = selection;
    const id: string | undefined = agent === 'claude' ? randomUUID() : undefined;
    const before = agent === 'codex' ? await codexSessionFiles() : undefined;
    const started = new Date().toISOString();
    const spec = agent === 'claude' ? claudeLaunch(executables.claude, cwd, prompt, id!, model, effort) : codexLaunch(executables.codex, cwd, prompt, model, effort);
    let savedId: string | undefined;
    const record = async () => {
      if (savedId) return;
      const sessionId = agent === 'claude' ? id : await identifyCodexSession(before!, await codexSessionFiles(), cwd, prompt);
      if (!sessionId || !await nativeExists({ agent, sessionId, cwd, model, effort, initialPrompt: prompt, createdAt: started })) return;
      await store.add(ticketKey(ticket), { agent, sessionId, cwd, model, effort, initialPrompt: prompt, createdAt: started, lastUsedAt: new Date().toISOString(), ticket });
      savedId = sessionId;
    };
    const code = await runAgent(spec, record);
    await record();
    const exitedUnexpectedly = code !== 0 && code !== 130;
    const saved = savedId
      ? `${agentName(agent)} session saved for #${ticket.id}`
      : `No verified ${agentName(agent)} session ID was found`;
    const detail = exitedUnexpectedly ? `${saved} · exited with code ${code}` : saved;
    await afterAgentClosed(detail, exitedUnexpectedly || !savedId);
  }
  async function agentDefaultsMenu(agent: Agent): Promise<void> {
    const caps = await capabilities(agent);
    let focusedOption: 'model' | 'effort' = 'model';
    while (true) {
      const current = (await launchPreferences.all()).agents[agent];
      screen(`${agentName(agent)} defaults`, caps.discovered ? 'Models and effort read from the installed CLI' : 'Using configured models because local discovery was unavailable', agent);
      const choice = await promptWithBack(signal => select<'model' | 'effort'>({ message: 'Choose a default', pageSize: 5, theme: menuTheme, default: focusedOption, choices: [
        { name: `◈  Model · ${accent(bold(modelDisplay(current.model, caps)))}`, value: 'model' },
        { name: `✦  Effort · ${warning(bold(effortLabel(current.effort)))}`, value: 'effort' }
      ] }, { signal }));
      if (choice === BACK) return;
      focusedOption = choice;
      let next: AgentLaunchDefaults = current;
      if (choice === 'model') {
        const selected = await selectModel(agent, current.model, caps);
        if (selected === BACK) continue;
        const efforts = availableEfforts(caps, selected);
        next = { model: selected, effort: current.effort !== null && !efforts.includes(current.effort) ? null : current.effort };
      } else {
        const selected = await selectEffort(agent, current.effort, current.model, caps);
        if (selected === BACK) continue;
        next = { ...current, effort: selected };
      }
      await launchPreferences.setAgent(agent, next);
      statusBar.set('success', `${agentName(agent)} defaults saved`);
    }
  }
  async function promptDefaultsMenu(kind: PromptKind): Promise<void> {
    while (true) {
      const preferences = await launchPreferences.all();
      const configured = provider.promptTemplate(kind);
      const current = preferences.prompts[provider.identity]?.[kind] ?? configured;
      const label = kind === 'bug' ? 'Bug' : 'User Story';
      screen(`${label} prompt default`, current);
      const choice = await promptWithBack(signal => select({ message: 'Prompt template', pageSize: 5, theme: menuTheme, choices: [
        { name: 'Edit prompt template', value: 'edit' },
        { name: 'Use configured provider template', value: 'reset' }
      ] }, { signal }));
      if (choice === BACK) return;
      if (choice === 'reset') await launchPreferences.setPrompt(provider.identity, kind, null);
      else {
        const selected = await promptWithBack(signal => input(editablePromptConfig(`${label} prompt template`, current), { signal }));
        if (selected === BACK) continue;
        await launchPreferences.setPrompt(provider.identity, kind, selected);
      }
      statusBar.set('success', `${label} prompt default saved`);
    }
  }
  async function launchDefaultsMenu(): Promise<void> {
    while (true) {
      const preferences = await launchPreferences.all();
      const promptPreferences = preferences.prompts[provider.identity];
      screen('Launch defaults', 'Preselected for new sessions · every launch can override them');
      const choice = await promptWithBack(signal => select<'claude' | 'codex' | PromptKind>({ message: 'Choose a default', pageSize: 9, theme: menuTheme, choices: [
        new Separator(accent(bold(menuSectionHeader('Agent defaults')))),
        new Separator(''),
        { name: launchDefaultsRow('Claude Code', launchDefaultsSummary(modelLabel(preferences.agents.claude.model), effortLabel(preferences.agents.claude.effort))), value: 'claude' },
        { name: launchDefaultsRow('Codex', launchDefaultsSummary(modelLabel(preferences.agents.codex.model), effortLabel(preferences.agents.codex.effort))), value: 'codex' },
        new Separator(''),
        new Separator(accent(bold(menuSectionHeader('Prompt defaults')))),
        new Separator(''),
        { name: launchDefaultsRow('Bug prompt', promptDefaultsSummary(promptPreferences?.bug !== undefined)), value: 'bug' },
        { name: launchDefaultsRow('User Story prompt', promptDefaultsSummary(promptPreferences?.userStory !== undefined)), value: 'userStory' }
      ] }, { signal }));
      if (choice === BACK) return;
      if (choice === 'claude' || choice === 'codex') await agentDefaultsMenu(choice);
      else await promptDefaultsMenu(choice as PromptKind);
    }
  }
  async function recover(ticket: Ticket): Promise<void> {
    const kind = promptKind(ticket);
    const preferences = await launchPreferences.all();
    const template = preferences.prompts[provider.identity]?.[kind] ?? provider.promptTemplate(kind);
    const prompt = provider.prompt(ticket, ticketAction(ticket), template);
    screen(`#${ticket.id}  Find native session`, 'Sessions whose first user prompt exactly matches this ticket');
    const candidates = [...await findClaudeTicketSessions(prompt), ...await findCodexTicketSessions(prompt)];
    const available = (await Promise.all(candidates.map(async candidate => await directoryExists(candidate.cwd) ? candidate : undefined)))
      .filter((candidate): candidate is (typeof candidates)[number] => candidate !== undefined);
    const existing = await store.list(ticketKey(ticket));
    const matches = available.filter(candidate => !existing.some(session => session.agent === candidate.agent && session.sessionId === candidate.sessionId));
    if (!matches.length) { console.log('No unrecorded native session with this exact ticket prompt was found.'); return; }
    const index = await promptWithBack(signal => select({ message: 'Record a session for this ticket', pageSize: 12, theme: menuTheme, choices: matches.map((candidate, index) => ({ name: `${candidate.agent === 'claude' ? 'Claude Code' : 'Codex'} · ${new Date(candidate.createdAt).toLocaleString()} · ${candidate.cwd}`, value: index })) }, { signal }));
    if (index === BACK) return;
    const candidate = matches[index]!;
    if (!await directoryExists(candidate.cwd) || !await nativeExists(candidate)) { console.log('Native session or working directory is no longer available.'); return; }
    await store.add(ticketKey(ticket), { ...candidate, lastUsedAt: candidate.createdAt, ticket });
    console.log(`Recorded ${candidate.agent} session ${candidate.sessionId} for #${ticket.id}.`);
  }
  async function resumeForKey(key: string, title: string, confirmSingle = false): Promise<boolean> {
    const sessions = await store.list(key);
    if (!sessions.length) { console.log('No session recorded for this ticket.'); return false; }
    if (sessions.length > 1 || confirmSingle) screen(title, 'Choose a saved conversation', 'resume');
    const index = sessions.length === 1 && !confirmSingle ? 0 : await promptWithBack(signal => select({ message: 'Resume session', pageSize: 12, theme: menuTheme, choices: sessions.map((s, index) => ({ name: `${s.agent === 'claude' ? 'Claude Code' : 'Codex'} · ${new Date(s.lastUsedAt ?? s.createdAt).toLocaleString()} · ${s.cwd}`, value: index })) }, { signal }));
    const session = index === BACK ? undefined : sessions[index];
    if (!session) return false;
    if (!await directoryExists(session.cwd)) { console.log(`Working directory no longer exists: ${session.cwd}`); return false; }
    if (!await nativeExists(session)) { console.log(`Native ${session.agent} session ${session.sessionId} is missing or inaccessible.`); return false; }
    screen(`Resume ${session.agent === 'claude' ? 'Claude Code' : 'Codex'}`, title, 'resume');
    const spec = session.agent === 'claude' ? claudeResume(executables.claude, session.cwd, session.sessionId) : codexResume(executables.codex, session.cwd, session.sessionId);
    const code = await runAgent(spec);
    const exitedUnexpectedly = code !== 0 && code !== 130;
    if (!exitedUnexpectedly) await store.touch(key, session.sessionId);
    const label = agentName(session.agent);
    const detail = exitedUnexpectedly
      ? `${label} exited with code ${code} · saved session kept`
      : `${label} session is ready to resume later`;
    await afterAgentClosed(detail, exitedUnexpectedly);
    return true;
  }
  async function ticketMenu(ticket: Ticket): Promise<void> {
    while (true) {
      screen(`#${ticket.id}  ${ticket.title}`, `${ticket.typeLabel} · ${ticket.status} · Priority: ${ticket.priority?.name ?? 'unavailable'}${ticket.url ? ` · ${ticket.url}` : ''}`);
      const sessions = await store.list(ticketKey(ticket));
      const action = ticket.type === 'Bug' ? 'Fix' : 'Implement';
      const choices = ticket.type === 'Unsupported' ? [] : [
        { name: `${action} with Claude Code`, value: 'claude', description: 'Review launch options, then start a native Claude session' },
        { name: `${action} with Codex`, value: 'codex', description: 'Review launch options, then start a native Codex session' }
      ];
      if (ticket.type === 'Unsupported') console.log(`  ${warning('No action mapped for this ticket type.')} ${muted('Set its type ID in config.json to enable it.')}\n`);
      console.log(`  ${muted('↑↓ move · Enter select · Esc back · Ctrl+C exit')}\n`);
      const choice = await promptWithBack(signal => select({ message: 'Choose an action', pageSize: 8, theme: menuTheme, choices: [...choices, ...(sessions.length ? [{ name: `Resume saved session${sessions.length > 1 ? `s (${sessions.length})` : ''}`, value: 'resume' }] : []), ...(ticket.type !== 'Unsupported' ? [{ name: 'Find existing native session', value: 'recover' }] : [])] }, { signal }));
      if (choice === BACK) return;
      try {
        if (choice === 'resume') await resumeForKey(ticketKey(ticket), `#${ticket.id} ${ticket.title}`);
        else if (choice === 'recover') await recover(ticket);
        else {
          const agent = choice as Agent;
          const options = await launchOptions(ticket, agent);
          if (options) await launch(ticket, agent, options);
        }
      }
      catch (error) {
        if (error instanceof ExitToTerminal) throw error;
        console.error(error instanceof Error ? error.message : String(error));
      }
    }
  }
  const args = process.argv.slice(2);
  if (args.length && args[0] !== 'mine' && args[0] !== 'show' && args[0] !== 'resume') throw new Error('Usage: opai [mine | show <id> | resume <id>]');
  if (args[0] === 'show' || args[0] === 'resume') {
    if (!args[1]) throw new Error('Ticket ID required.');
    if (args[0] === 'resume') {
      if (!await resumeForKey(`${provider.identity}:${args[1]}`, `Ticket #${args[1]}`, true)) return;
    } else {
      const ticket = await statusBar.run(`Loading ticket #${args[1]}`, () => provider.get(args[1]), item => `Ticket #${item.id} loaded`);
      await ticketMenu(ticket);
      return;
    }
  }
  async function browseTickets(key: string, label: string, load: () => Promise<Ticket[]>): Promise<void> {
    const tickets = await cachedTickets(key, load, label);
    while (true) {
      screen(label, `${tickets.length} ticket${tickets.length === 1 ? '' : 's'} · auto refresh after ${config.cacheTtlHours ?? 8}h`);
      if (!tickets.length) console.log(`  ${muted('No tickets in this list.')}\n`);
      console.log(`  ${hint()}\n`);
      const selected = await promptWithBack(signal => search<Ticket>({ message: 'Search by ID or title', pageSize: 12, theme: listTheme, source: async term => {
        const filtered = tickets.filter(ticket => `${ticket.id} ${ticket.title} ${ticket.typeLabel} ${ticket.priority?.name ?? ''}`.toLowerCase().includes((term ?? '').toLowerCase()));
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
      const choice = await promptWithBack(signal => select({ message: 'What would you like to do?', theme: menuTheme, choices: [
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
      } catch (error) {
        if (error instanceof ExitToTerminal) throw error;
        console.error(error instanceof Error ? error.message : String(error));
      }
    }
  }
  async function savedQueries(): Promise<void> {
    const queries = await cachedList(queryCache, 'saved', () => provider.listSavedQueries(), 'saved queries', 'queries');
    while (true) {
      screen('Saved queries', `${queries.length} quer${queries.length === 1 ? 'y' : 'ies'} · auto refresh after ${config.cacheTtlHours ?? 8}h`);
      console.log(`  ${muted('Type to search · ↑↓ move · Enter select · Esc back')}\n`);
      const preferences = await queryPreferences.all();
      const choice = await promptWithBack(signal => search<SavedQuery>({ message: 'Search saved queries', pageSize: 15, theme: listTheme, source: async term => {
        const filtered = queries.filter(query => `${query.id} ${query.name}`.toLowerCase().includes((term ?? '').toLowerCase()));
        return querySections(filtered, preferences, provider.identity).flatMap(section => {
          const heading = section.kind === 'pinned'
            ? warning(bold('── ★ Pinned ─────────────────────'))
            : section.kind === 'recent'
              ? accent(bold('── ◷ Recently viewed ────────────'))
              : bold('── All queries ─────────────────');
          const marker = section.kind === 'pinned' ? '★' : section.kind === 'recent' ? '◷' : '▤';
          return [
            new Separator(heading),
            ...section.queries.map(query => ({ name: `${marker}  ${query.name}`, value: query, short: query.name }))
          ];
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
    const choice = await promptWithBack(signal => select({ message: 'Choose a view', theme: menuTheme, choices: [
      { name: 'My tickets', value: 'mine' },
      { name: 'Saved queries', value: 'queries' },
      { name: 'My sessions', value: 'sessions' },
      { name: 'Launch defaults', value: 'launch-defaults' },
      { name: '↻  Refresh my tickets', value: 'refresh-mine' },
      { name: '↻  Refresh saved queries', value: 'refresh-queries' },
      { name: '×  Exit OPAI', value: 'exit' }
    ] }, { signal }));
    if (choice === 'exit' || choice === BACK) return;
    try {
      if (choice === 'mine') await browseTickets('mine', 'My tickets', () => provider.listAssigned());
      else if (choice === 'queries') await savedQueries();
      else if (choice === 'sessions') await mySessions();
      else if (choice === 'launch-defaults') await launchDefaultsMenu();
      else if (choice === 'refresh-mine') {
        await cachedTickets('mine', () => provider.listAssigned(), 'my tickets', true, true);
      } else {
        await cachedList(queryCache, 'saved', () => provider.listSavedQueries(), 'saved queries', 'queries', true);
      }
    } catch (error) {
      if (error instanceof ExitToTerminal) throw error;
      console.error(error instanceof Error ? error.message : String(error));
    }
  }
}
main().then(goodbye).catch(error => {
  if (aborted(error) || error instanceof ExitToTerminal) goodbye();
  else { console.error(error instanceof Error ? error.message : String(error)); process.exitCode = 1; }
});
