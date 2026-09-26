import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, mkdir, readFile, rm, writeFile, stat } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { OpenProjectProvider } from './providers/openproject.js';
import { ticketKey } from './providers/types.js';
import { SessionStore, sessionTickets } from './sessions/store.js';
import { claudeLaunch, claudeResume, findClaudeTicketSessions, nativeClaudeSessionExists } from './agents/claude.js';
import { codexLaunch, codexResume, findCodexTicketSessions, identifyCodexSession } from './agents/codex.js';
import { ListCache, isSavedQueryList, isTicketList, newlyAssignedTicketIds, orderAssignedTickets } from './list-cache.js';
import { centeredMenuChoices, createOpaiPalette, listHighlight, renderAgentClosed, renderGoodbye, renderHeader, selectionCursor, sessionRow, setIdleMascotMood, sinceLastOpened, ticketRow, visibleWidth } from './ui.js';
import { loadApiToken, saveApiToken } from './token.js';
import { StatusBar } from './status.js';
import { QueryPreferencesStore, orderedQueries, querySections } from './query-preferences.js';
import { EventEmitter } from 'node:events';
import { stripVTControlCharacters } from 'node:util';
import { BACK, isQuickBackKey, promptWithBack } from './back.js';
import { syncSessionTickets } from './sessions/sync.js';
import { DashboardHistoryStore, buildDashboard, renderDashboard } from './dashboard.js';
import { LaunchPreferenceStore } from './launch-preferences.js';
import { modelOptions, parseConfiguredModels, resolvePreferredModel } from './models.js';
import { runAgent } from './agents/run.js';
import { availableEfforts, parseClaudeHelp, parseCodexModelCatalog, resolveEffort } from './agents/capabilities.js';
import { parseConfig, parsePromptTemplates } from './config.js';
import { buildLaunchMenu, editablePromptConfig, launchDefaultsSummary, launchDefaultsRow, menuSectionHeader, promptDefaultsSummary } from './launch-menu.js';
import { MascotRotationStore } from './ui-state.js';
import { cliHelp, initializeConfig, parseCliCommand } from './command.js';
import { UpdateChecker, isNewerVersion } from './update-check.js';
const settings = { url: 'https://example.test', instanceId: 'main', bugTypeId: 7, userStoryTypeId: 6 };
const unstyled = (value: string): string => stripVTControlCharacters(value);
const wp = (id: number, type: number, name = 'Bug') => ({ id, subject: `Ticket ${id}`, _links: { type: { href: `/api/v3/types/${type}`, title: name }, status: { href: '/api/v3/statuses/4', title: 'In progress' }, priority: { href: '/api/v3/priorities/3', title: 'High' } } });
test('OpenProject paginates, filters assigned open tickets, and normalizes stable type IDs', async () => {
  const calls: URL[] = [];
  const request = (async (url: string) => { const parsed = new URL(url); calls.push(parsed); const body = parsed.pathname.endsWith('/users/me') ? { id: 42 } : parsed.searchParams.get('offset') === '1' ? { total: 2, count: 1, offset: 1, _embedded: { elements: [wp(5, 7)] } } : { total: 2, count: 1, offset: 2, _embedded: { elements: [wp(6, 6, 'User Story')] } }; return { ok: true, json: async () => body }; }) as unknown as typeof fetch;
  const provider = new OpenProjectProvider(settings, 'secret', request);
  const tickets = await provider.listAssigned();
  assert.deepEqual(tickets.map(x => x.type), ['Bug', 'User Story']);
  assert.deepEqual(JSON.parse(calls[1].searchParams.get('filters')!), [{ assignee: { operator: '=', values: ['42'] } }, { status: { operator: 'o', values: [] } }]);
  assert.deepEqual(JSON.parse(calls[1].searchParams.get('sortBy')!), [['updatedAt', 'desc']]);
  assert.equal(calls[2].searchParams.get('sortBy'), calls[1].searchParams.get('sortBy'));
  assert.equal(calls[2].searchParams.get('offset'), '2');
  assert.equal(provider.prompt(tickets[0], 'fix'), 'fix openproject bug 5');
  assert.equal(provider.prompt(tickets[1], 'implement'), 'implement openproject user story 6');
  assert.deepEqual(tickets[0].priority, { id: '3', name: 'High' });
  assert.equal(provider.normalize(wp(7, 99)).type, 'Unsupported');
  assert.equal(provider.normalize(wp(7, 99)).typeLabel, 'Bug');
  assert.throws(() => provider.prompt(provider.normalize(wp(7, 99)), 'fix'));
  assert.equal(ticketKey(tickets[0]), 'openproject@main:5');
});
test('OpenProject prompt templates use the ticket placeholder and preserve provider defaults', () => {
  const provider = new OpenProjectProvider({
    ...settings,
    promptTemplates: {
      bug: 'repair OpenProject issue {{id}}',
      userStory: 'deliver OpenProject story {{id}}'
    }
  }, 'secret');
  const bug = provider.normalize(wp(45, 7));
  const story = provider.normalize(wp(46, 6, 'User Story'));
  assert.equal(provider.promptTemplate('bug'), 'repair OpenProject issue {{id}}');
  assert.equal(provider.promptTemplate('userStory'), 'deliver OpenProject story {{id}}');
  assert.equal(provider.prompt(bug, 'fix'), 'repair OpenProject issue 45');
  assert.equal(provider.prompt(story, 'implement'), 'deliver OpenProject story 46');
  assert.equal(provider.prompt(bug, 'fix', 'inspect {{id}} then fix {{id}}'), 'inspect 45 then fix 45');
  assert.throws(() => provider.prompt(bug, 'fix', 'missing ticket placeholder'), /must contain \{\{id\}\}/);
});
test('sessions persist, retain multiple records, and reject invalid records', async () => {
  const dir = await mkdtemp(join(tmpdir(), 'opai-test-'));
  try {
    const path = join(dir, 'sessions.json'); const store = new SessionStore(path);
    const first = { agent: 'claude' as const, sessionId: '00000000-0000-4000-8000-000000000001', cwd: dir, createdAt: new Date().toISOString() };
    await store.add('openproject@main:5', first);
    await store.add('openproject@main:5', { ...first, sessionId: '00000000-0000-4000-8000-000000000002' });
    assert.equal((await new SessionStore(path).list('openproject@main:5')).length, 2);
    await store.touch('openproject@main:5', first.sessionId);
    assert.ok((await store.list('openproject@main:5'))[0].lastUsedAt);
    await assert.rejects(store.touch('openproject@main:5', 'missing'));
    await assert.rejects(store.add('openproject@main:5', { ...first, sessionId: 'invented' }));
    assert.equal(JSON.parse(await readFile(path, 'utf8'))['openproject@main:5'].length, 2);
  } finally { await rm(dir, { recursive: true, force: true }); }
});
test('fresh ticket data updates saved session status without changing native session details', async () => {
  const dir = await mkdtemp(join(tmpdir(), 'opai-status-sync-test-'));
  try {
    const store = new SessionStore(join(dir, 'sessions.json'));
    const key = 'openproject@main:5';
    const old = { agent: 'claude' as const, sessionId: '00000000-0000-4000-8000-000000000021', cwd: '/repo', createdAt: '2026-09-21T10:00:00Z' };
    await store.add(key, old);
    await store.add(key, { ...old, agent: 'codex', sessionId: '00000000-0000-4000-8000-000000000022', ticket: { id: '5', provider: 'openproject@main', title: 'Old title', type: 'Bug', typeLabel: 'Bug', status: 'Open' } });
    const fresh = { id: '5', provider: 'openproject@main', title: 'New title', type: 'Bug' as const, typeLabel: 'Bug', status: 'Developed' };
    assert.equal(await store.syncTickets([fresh]), 2);
    const saved = await new SessionStore(join(dir, 'sessions.json')).list(key);
    assert.deepEqual(saved.map(session => [session.ticket?.status, session.cwd, session.createdAt]), [
      ['Developed', '/repo', old.createdAt], ['Developed', '/repo', old.createdAt]
    ]);
    assert.equal(sessionTickets(await store.all(), 'openproject@main')[0].status, 'Developed');
    assert.equal(await store.syncTickets([{ ...fresh, provider: 'openproject@other', status: 'Wrong instance' }]), 0);
    assert.equal(await store.syncTickets([fresh]), 0);
  } finally { await rm(dir, { recursive: true, force: true }); }
});
test('explicit refresh checks saved tickets absent from assigned list', async () => {
  const dir = await mkdtemp(join(tmpdir(), 'opai-missing-status-test-'));
  try {
    const store = new SessionStore(join(dir, 'sessions.json'));
    const old = { agent: 'claude' as const, sessionId: '00000000-0000-4000-8000-000000000023', cwd: '/repo', createdAt: '2026-09-21T10:00:00Z' };
    await store.add('openproject@main:5', old);
    await store.add('openproject@main:6', { ...old, sessionId: '00000000-0000-4000-8000-000000000024' });
    const listed = { id: '5', provider: 'openproject@main', title: 'Five', type: 'Bug' as const, typeLabel: 'Bug', status: 'Open' };
    const calls: string[] = [];
    const provider = { identity: 'openproject@main', get: async (id: string) => { calls.push(id); return { ...listed, id, title: 'Six', status: 'Closed' }; } };
    await syncSessionTickets(store, provider, [listed], false);
    assert.deepEqual(calls, []);
    const result = await syncSessionTickets(store, provider, [listed], true);
    assert.deepEqual(calls, ['6']);
    assert.deepEqual(result.unavailable, []);
    assert.equal((await store.list('openproject@main:6'))[0].ticket?.status, 'Closed');
  } finally { await rm(dir, { recursive: true, force: true }); }
});
test('agent arguments preserve exact prompt and native resume ID', () => {
  const id = '00000000-0000-4000-8000-000000000001';
  assert.deepEqual(claudeLaunch('claude', '/repo', 'fix openproject bug 5', id).args, ['--session-id', id, 'fix openproject bug 5']);
  assert.deepEqual(claudeLaunch('claude', '/repo', 'fix openproject bug 5', id, 'sonnet', 'high').args, ['--session-id', id, '--model', 'sonnet', '--effort', 'high', 'fix openproject bug 5']);
  assert.deepEqual(claudeResume('claude', '/repo', id).args, ['--resume', id]);
  assert.deepEqual(codexLaunch('codex', '/repo', 'fix openproject bug 5').args, ['fix openproject bug 5']);
  assert.deepEqual(codexLaunch('codex', '/repo', 'fix openproject bug 5', 'gpt-custom', 'xhigh').args, ['--model', 'gpt-custom', '-c', 'model_reasoning_effort="xhigh"', 'fix openproject bug 5']);
  assert.deepEqual(codexLaunch('codex', '/repo', 'fix openproject bug 5', null, 'medium').args, ['-c', 'model_reasoning_effort="medium"', 'fix openproject bug 5']);
  assert.deepEqual(codexResume('codex', '/repo', id).args, ['resume', id]);
});
test('resume commands never apply current or historical launch options', () => {
  const id = '00000000-0000-4000-8000-000000000002';
  assert.deepEqual(claudeResume('claude', '/repo', id).args, ['--resume', id]);
  assert.deepEqual(codexResume('codex', '/repo', id).args, ['resume', id]);
});
test('model options include Claude aliases and only configured Codex models', () => {
  assert.deepEqual(modelOptions('claude', ['custom-claude', 'sonnet']).map(option => option.value), [null, 'sonnet', 'opus', 'haiku', 'custom-claude']);
  assert.deepEqual(modelOptions('codex', ['gpt-custom']).map(option => option.value), [null, 'gpt-custom']);
  assert.equal(resolvePreferredModel('claude', 'sonnet', []), 'sonnet');
  assert.equal(resolvePreferredModel('codex', null, []), null);
  assert.throws(() => resolvePreferredModel('codex', 'not-configured', ['gpt-custom']), /not available/);
  assert.throws(() => modelOptions('codex', ['--invalid']), /Invalid codex model ID/);
});
test('Codex bundled catalog exposes visible model versions and their effort choices', () => {
  const catalog = JSON.stringify({ models: [
    { slug: 'gpt-visible', display_name: 'GPT Visible', visibility: 'list', default_reasoning_level: 'medium', supported_reasoning_levels: [{ effort: 'low' }, { effort: 'medium' }, { effort: 'high' }] },
    { slug: 'gpt-hidden', display_name: 'GPT Hidden', visibility: 'hide', default_reasoning_level: 'high', supported_reasoning_levels: [{ effort: 'high' }] }
  ] });
  const models = parseCodexModelCatalog(catalog, ['custom-codex']);
  assert.deepEqual(models, [
    { id: 'gpt-visible', label: 'GPT Visible', defaultEffort: 'medium', efforts: ['low', 'medium', 'high'] },
    { id: 'custom-codex', label: 'custom-codex', efforts: [] }
  ]);
  const capabilities = { models, efforts: [], discovered: true };
  assert.deepEqual(availableEfforts(capabilities, 'gpt-visible'), ['low', 'medium', 'high']);
  assert.deepEqual(availableEfforts(capabilities, 'custom-codex'), ['low', 'medium', 'high']);
  assert.deepEqual(availableEfforts(capabilities, null), ['low', 'medium', 'high']);
  assert.equal(resolveEffort('high', availableEfforts(capabilities, 'gpt-visible')), 'high');
  assert.equal(resolveEffort(null, []), null);
  assert.throws(() => resolveEffort('ultra', availableEfforts(capabilities, 'gpt-visible')), /not available/);
});
test('Claude installed help supplies aliases and effort choices with stable fallbacks', () => {
  const help = [
    "  --model <model>  Model alias (e.g. 'fable', 'opus', or 'sonnet') or a model's full name",
    '  --effort <level> Effort level (low, medium, high, xhigh, max)',
    '  --resume [value] Resume a session'
  ].join('\n');
  const capabilities = parseClaudeHelp(help, ['company-model']);
  assert.deepEqual(capabilities.models.map(model => model.id), ['sonnet', 'opus', 'haiku', 'fable', 'company-model']);
  assert.deepEqual(capabilities.efforts, ['low', 'medium', 'high', 'xhigh', 'max']);
  assert.deepEqual(parseClaudeHelp('', []).efforts, ['low', 'medium', 'high', 'xhigh', 'max']);
});
test('configured model lists reject malformed structures and identifiers', () => {
  assert.deepEqual(parseConfiguredModels(undefined), undefined);
  assert.deepEqual(parseConfiguredModels({ claude: ['custom-claude', 'claude-model[1m]'], codex: ['gpt-custom'] }), { claude: ['custom-claude', 'claude-model[1m]'], codex: ['gpt-custom'] });
  assert.throws(() => parseConfiguredModels({ codex: 'gpt-custom' }), /models.codex must be an array/);
  assert.throws(() => parseConfiguredModels({ claude: ['--invalid'] }), /Invalid claude model ID/);
});
test('configured prompt templates require the ticket placeholder', () => {
  assert.deepEqual(parsePromptTemplates(undefined), undefined);
  assert.deepEqual(parsePromptTemplates({ bug: 'fix {{id}}', userStory: 'build {{id}}' }), { bug: 'fix {{id}}', userStory: 'build {{id}}' });
  assert.throws(() => parsePromptTemplates('fix {{id}}'), /promptTemplates must be an object/);
  assert.throws(() => parsePromptTemplates({ bug: 'missing placeholder' }), /promptTemplates.bug must contain \{\{id\}\}/);
});
test('launch defaults persist per agent and prompt type and can return to Default', async () => {
  const dir = await mkdtemp(join(tmpdir(), 'opai-launch-preferences-test-'));
  try {
    const path = join(dir, 'launch.json');
    const store = new LaunchPreferenceStore(path);
    assert.deepEqual(await store.all(), {
      agents: { claude: { model: null, effort: null }, codex: { model: null, effort: null } },
      prompts: {}
    });
    await store.setAgent('claude', { model: 'sonnet', effort: 'high' });
    await store.setAgent('codex', { model: 'gpt-custom', effort: null });
    await store.setPrompt('openproject@main', 'bug', 'repair ticket {{id}}');
    assert.deepEqual(await new LaunchPreferenceStore(path).all(), {
      agents: { claude: { model: 'sonnet', effort: 'high' }, codex: { model: 'gpt-custom', effort: null } },
      prompts: { 'openproject@main': { bug: 'repair ticket {{id}}' } }
    });
    await store.setAgent('claude', { model: null, effort: null });
    await store.setPrompt('openproject@main', 'bug', null);
    assert.deepEqual(await store.all(), {
      agents: { claude: { model: null, effort: null }, codex: { model: 'gpt-custom', effort: null } },
      prompts: {}
    });
    await assert.rejects(store.setPrompt('openproject@main', 'userStory', 'missing placeholder'), /must contain \{\{id\}\}/);
  } finally { await rm(dir, { recursive: true, force: true }); }
});
test('session launch options are historical metadata and older records load as Default', async () => {
  const dir = await mkdtemp(join(tmpdir(), 'opai-session-model-test-'));
  try {
    const path = join(dir, 'sessions.json');
    const old = { agent: 'claude', sessionId: '00000000-0000-4000-8000-000000000041', cwd: '/repo', createdAt: '2026-09-23T10:00:00Z' };
    await writeFile(path, JSON.stringify({ 'openproject@main:5': [old] }));
    const store = new SessionStore(path);
    assert.deepEqual(await store.list('openproject@main:5'), [{ ...old, model: null, effort: null, initialPrompt: null }]);
    await store.add('openproject@main:5', { ...old, agent: 'codex', sessionId: '00000000-0000-4000-8000-000000000042', model: 'gpt-custom', effort: 'high', initialPrompt: 'repair ticket 5' } as Parameters<SessionStore['add']>[1]);
    assert.deepEqual((await store.list('openproject@main:5')).map(session => [session.model, session.effort, session.initialPrompt]), [
      [null, null, null],
      ['gpt-custom', 'high', 'repair ticket 5']
    ]);
  } finally { await rm(dir, { recursive: true, force: true }); }
});
test('agent process failures return their exit code without creating fallback behavior', async () => {
  const child = new EventEmitter();
  const spawnProcess = (() => { queueMicrotask(() => child.emit('exit', 2, null)); return child; }) as never;
  assert.equal(await runAgent({ executable: 'codex', cwd: '/repo', args: ['--model', 'bad-model', 'fix openproject bug 5'] }, undefined, spawnProcess), 2);
});
test('Codex capture refuses absent metadata', async () => {
  assert.equal(await identifyCodexSession(new Map(), new Map(), '/repo', 'prompt'), undefined);
});
test('Codex capture requires a unique new session with matching cwd and exact prompt', async () => {
  const dir = await mkdtemp(join(tmpdir(), 'opai-codex-test-'));
  try {
    const id = '00000000-0000-4000-8000-000000000003';
    const path = join(dir, `rollout-${id}.jsonl`);
    await writeFile(path, [
      JSON.stringify({ type: 'session_meta', payload: { id, cwd: '/repo' } }),
      JSON.stringify({ type: 'response_item', payload: { type: 'message', role: 'user', content: [{ type: 'input_text', text: 'fix openproject bug 5' }] } })
    ].join('\n'));
    const after = new Map([[path, path]]);
    assert.equal(await identifyCodexSession(new Map(), after, '/repo', 'fix openproject bug 5'), id);
    assert.equal(await identifyCodexSession(new Map(), after, '/other', 'fix openproject bug 5'), undefined);
    assert.equal(await identifyCodexSession(new Map(), after, '/repo', 'fix openproject bug 6'), undefined);
    assert.equal(await identifyCodexSession(after, after, '/repo', 'fix openproject bug 5'), undefined);
    const second = join(dir, 'other.jsonl');
    await writeFile(second, await readFile(path));
    assert.equal(await identifyCodexSession(new Map(), new Map([[path, path], [second, second]]), '/repo', 'fix openproject bug 5'), undefined);
  } finally { await rm(dir, { recursive: true, force: true }); }
});
test('native recovery only offers sessions whose first user prompt matches the ticket', async () => {
  const dir = await mkdtemp(join(tmpdir(), 'opai-recovery-test-'));
  try {
    const claudeRoot = join(dir, 'claude');
    const codexRoot = join(dir, 'codex');
    await mkdir(join(claudeRoot, 'project'), { recursive: true });
    await mkdir(codexRoot);
    const claudeId = '00000000-0000-4000-8000-000000000011';
    const codexId = '00000000-0000-4000-8000-000000000012';
    await writeFile(join(claudeRoot, 'project', `${claudeId}.jsonl`), [
      JSON.stringify({ type: 'user', sessionId: claudeId, cwd: '/repo', timestamp: '2026-09-22T10:00:00Z', message: { content: 'fix openproject bug 5' } }),
      JSON.stringify({ type: 'user', sessionId: claudeId, cwd: '/repo', message: { content: 'fix openproject bug 6' } })
    ].join('\n'));
    await writeFile(join(codexRoot, `rollout-${codexId}.jsonl`), [
      JSON.stringify({ type: 'session_meta', payload: { id: codexId, cwd: '/repo', timestamp: '2026-09-22T10:00:00Z' } }),
      JSON.stringify({ type: 'event_msg', payload: { type: 'user_message', message: 'fix openproject bug 5' } }),
      JSON.stringify({ type: 'event_msg', payload: { type: 'user_message', message: 'fix openproject bug 6' } })
    ].join('\n'));
    assert.equal(await nativeClaudeSessionExists(claudeId, claudeRoot), true);
    assert.equal((await findClaudeTicketSessions('fix openproject bug 5', claudeRoot)).length, 1);
    assert.equal((await findClaudeTicketSessions('fix openproject bug 6', claudeRoot)).length, 0);
    assert.equal((await findCodexTicketSessions('fix openproject bug 5', codexRoot)).length, 1);
    assert.equal((await findCodexTicketSessions('fix openproject bug 6', codexRoot)).length, 0);
  } finally { await rm(dir, { recursive: true, force: true }); }
});
test('OpenProject connection errors report the configured host and DNS code without token', async () => {
  const request = (async () => { throw Object.assign(new TypeError('fetch failed'), { cause: { code: 'EAI_AGAIN' } }); }) as unknown as typeof fetch;
  const provider = new OpenProjectProvider(settings, 'secret-token', request);
  await assert.rejects(provider.listAssigned(), error => {
    assert.match((error as Error).message, /example\.test.*EAI_AGAIN/);
    assert.doesNotMatch((error as Error).message, /secret-token/);
    return true;
  });
});
test('OpenProject requests time out and configuration validates the timeout', async () => {
  const request = ((_url: string, options?: RequestInit) => new Promise((_resolve, reject) => {
    options?.signal?.addEventListener('abort', () => reject(options.signal?.reason), { once: true });
  })) as unknown as typeof fetch;
  const provider = new OpenProjectProvider({ ...settings, requestTimeoutSeconds: 0.001 }, 'secret-token', request);
  await assert.rejects(provider.listAssigned(), /timed out after 0.001s/);
  const valid = parseConfig({ openproject: { ...settings, requestTimeoutSeconds: 20 }, updateCheckDays: 7 });
  assert.equal(valid.openproject.requestTimeoutSeconds, 20);
  assert.equal(valid.updateCheckDays, 7);
  assert.throws(() => parseConfig({ openproject: { ...settings, requestTimeoutSeconds: 0 } }), /integer from 1 to 120/);
  assert.throws(() => parseConfig({ openproject: settings, updateCheckDays: 91 }), /updateCheckDays/);
});
test('update checks are cached for seven days and only report newer stable versions', async () => {
  const dir = await mkdtemp(join(tmpdir(), 'opai-update-test-'));
  try {
    let now = 1_000_000;
    let calls = 0;
    let latest = '0.1.2';
    const request = (async () => { calls++; return { ok: true, json: async () => ({ version: latest }) }; }) as unknown as typeof fetch;
    const checker = () => new UpdateChecker('0.1.1', { path: join(dir, 'update-check.json'), intervalMs: 7 * 86_400_000, request, now: () => now });
    assert.deepEqual(await checker().check(), { currentVersion: '0.1.1', latestVersion: '0.1.2' });
    assert.equal(calls, 1);
    assert.deepEqual(await checker().check(), { currentVersion: '0.1.1', latestVersion: '0.1.2' });
    assert.equal(calls, 1);
    now += 7 * 86_400_000 + 1;
    latest = '0.1.1';
    assert.equal(await checker().check(), undefined);
    assert.equal(calls, 2);
    assert.equal(isNewerVersion('1.0.0', '0.9.9'), true);
    assert.equal(isNewerVersion('1.0.0-beta.1', '0.9.9'), false);
    assert.equal(isNewerVersion('invalid', '0.9.9'), false);
  } finally { await rm(dir, { recursive: true, force: true }); }
});
test('failed update checks stay silent and respect the cached retry interval', async () => {
  const dir = await mkdtemp(join(tmpdir(), 'opai-update-failure-test-'));
  try {
    let calls = 0;
    const request = (async () => { calls++; throw new Error('offline'); }) as unknown as typeof fetch;
    const options = { path: join(dir, 'update-check.json'), intervalMs: 1000, request, now: () => 50_000 };
    assert.equal(await new UpdateChecker('0.1.1', options).check(), undefined);
    assert.equal(await new UpdateChecker('0.1.1', options).check(), undefined);
    assert.equal(calls, 1);
  } finally { await rm(dir, { recursive: true, force: true }); }
});
test('lists survive process restarts and reload only after TTL or explicit refresh', async () => {
  const dir = await mkdtemp(join(tmpdir(), 'opai-cache-test-'));
  try {
    let now = 1_000_000;
    let calls = 0;
    const load = async () => { calls++; return [{ id: String(calls), name: `version ${calls}` }]; };
    const cache = () => new ListCache('instance:user', 8 * 60 * 60 * 1000, isSavedQueryList, dir, () => now);
    assert.deepEqual(await cache().get('mine', load), [{ id: '1', name: 'version 1' }]);
    now += 60 * 60 * 1000;
    assert.deepEqual(await cache().get('mine', load), [{ id: '1', name: 'version 1' }]);
    assert.equal(calls, 1);
    now += 8 * 60 * 60 * 1000;
    assert.deepEqual(await cache().get('mine', load), [{ id: '2', name: 'version 2' }]);
    assert.deepEqual(await cache().get('mine', load, true), [{ id: '3', name: 'version 3' }]);
    assert.deepEqual(await cache().get('query:5', load), [{ id: '4', name: 'version 4' }]);
    assert.deepEqual(await new ListCache('other-account', 8 * 60 * 60 * 1000, isSavedQueryList, dir, () => now).get('mine', load), [{ id: '5', name: 'version 5' }]);
    assert.equal(calls, 5);
  } finally { await rm(dir, { recursive: true, force: true }); }
});
test('newly observed assigned tickets move to the top while known tickets keep their order', () => {
  const ticket = (id: string, title = `Ticket ${id}`) => ({ id, provider: 'openproject@main', title, type: 'Bug' as const, typeLabel: 'Bug', status: 'New' });
  const previous = [ticket('8'), ticket('5'), ticket('3')];
  const fresh = [ticket('5', 'Updated five'), ticket('9'), ticket('3', 'Updated three'), ticket('8', 'Updated eight'), ticket('7')];
  const ordered = orderAssignedTickets(previous, fresh);
  assert.deepEqual(ordered.map(item => item.id), ['9', '7', '8', '5', '3']);
  assert.equal(ordered.find(item => item.id === '5')?.title, 'Updated five');
  assert.deepEqual(orderAssignedTickets(undefined, fresh), fresh);
  assert.deepEqual([...newlyAssignedTicketIds(previous, fresh)], ['9', '7']);
  assert.deepEqual([...newlyAssignedTicketIds(undefined, fresh)], []);
});
test('expired lists fall back to stale cache after an automatic refresh failure', async () => {
  const dir = await mkdtemp(join(tmpdir(), 'opai-stale-cache-test-'));
  try {
    let now = 100;
    const cache = new ListCache('instance:user', 10, isSavedQueryList, dir, () => now);
    await cache.get('queries', async () => [{ id: '1', name: 'Saved' }]);
    now = 111;
    const result = await cache.getWithMetadata('queries', async () => { throw new Error('offline'); });
    assert.deepEqual(result, { value: [{ id: '1', name: 'Saved' }], source: 'stale' });
    await assert.rejects(cache.getWithMetadata('queries', async () => { throw new Error('offline'); }, true), /offline/);
  } finally { await rm(dir, { recursive: true, force: true }); }
});
test('CLI utility commands work before OpenProject configuration is loaded', async () => {
  assert.deepEqual(parseCliCommand([]), { kind: 'interactive' });
  assert.deepEqual(parseCliCommand(['--help']), { kind: 'help' });
  assert.deepEqual(parseCliCommand(['-v']), { kind: 'version' });
  assert.deepEqual(parseCliCommand(['show', '42']), { kind: 'show', id: '42' });
  assert.throws(() => parseCliCommand(['show']), /Ticket ID required/);
  assert.throws(() => parseCliCommand(['unknown']), /Usage:/);
  assert.match(cliHelp, /opai init/);
  assert.match(cliHelp, /opai --version/);

  const dir = await mkdtemp(join(tmpdir(), 'opai-init-test-'));
  try {
    const destination = join(dir, 'config.json');
    await initializeConfig(destination, '{"openproject":{"url":"https://example.com"}}\n');
    assert.equal(await readFile(destination, 'utf8'), '{"openproject":{"url":"https://example.com"}}\n');
    assert.equal((await stat(destination)).mode & 0o777, 0o600);
    await assert.rejects(initializeConfig(destination, '{}'), /already exists/);
  } finally { await rm(dir, { recursive: true, force: true }); }
});
test('dashboard uses stale cache without fetching and renders all local quest stats', async () => {
  const dir = await mkdtemp(join(tmpdir(), 'opai-dashboard-test-'));
  try {
    let now = Date.parse('2026-09-22T12:00:00Z');
    const tickets = [
      { id: '5', provider: 'openproject@main', title: 'Fix charts', type: 'Bug' as const, typeLabel: 'Bug', status: 'In progress' },
      { id: '6', provider: 'openproject@main', title: 'Build report', type: 'User Story' as const, typeLabel: 'User Story', status: 'New' }
    ];
    const cache = new ListCache('dashboard', 1, isTicketList, join(dir, 'cache'), () => now);
    await cache.get('mine', async () => tickets);
    now += 10_000;
    const cached = await new ListCache('dashboard', 1, isTicketList, join(dir, 'cache'), () => now).peek('mine');
    assert.deepEqual(cached, { fetchedAt: now - 10_000, value: tickets });
    const history = new DashboardHistoryStore(join(dir, 'history.json'));
    await history.record('openproject@main', [{ ...tickets[0], id: '4' }, ...tickets], new Date('2026-09-21T12:00:00Z'));
    await history.record('openproject@main', tickets, new Date(now));
    const registry = {
      'openproject@main:5': [{ agent: 'claude' as const, sessionId: '00000000-0000-4000-8000-000000000031', cwd: '/repo', createdAt: '2026-09-22T10:00:00Z', lastUsedAt: '2026-09-22T11:00:00Z', usedAt: ['2026-09-22T10:00:00Z', '2026-09-22T11:00:00Z'], ticket: tickets[0] }],
      'openproject@main:6': [{ agent: 'codex' as const, sessionId: '00000000-0000-4000-8000-000000000032', cwd: '/repo', createdAt: '2026-09-20T10:00:00Z', usedAt: ['2026-09-20T10:00:00Z'], ticket: tickets[1] }]
    };
    const model = buildDashboard(tickets, cached!.fetchedAt, registry, 'openproject@main', await history.list('openproject@main'), now);
    assert.deepEqual([model.open, model.bugs, model.stories, model.sessions, model.resumable], [2, 1, 1, 2, 2]);
    assert.equal(model.clearedThisWeek, 1);
    assert.equal(model.touchedThisWeek, 2);
    const output = renderDashboard(model, 80);
    for (const text of ['QUEST STATUS', 'AGENT PARTY', 'WEEKLY QUESTS', '7-DAY ACTIVITY', 'OPEN QUEST TREND', 'LAST QUEST', 'In progress', 'Claude', 'Codex', 'Fix charts']) assert.match(output, new RegExp(text));
    const mark = (name: string) => (value: string) => `<${name}>${value}</${name}>`;
    const styled = renderDashboard(model, 80, now, {
      heading: mark('heading'), positive: mark('positive'), warning: mark('warning'),
      danger: mark('danger'), accent: mark('accent'), bold: mark('bold')
    });
    for (const heading of ['QUEST STATUS', 'AGENT PARTY', 'WEEKLY QUESTS', '7-DAY ACTIVITY', 'OPEN QUEST TREND', 'LAST QUEST']) {
      assert.match(styled, new RegExp(`<heading>[^<]*${heading}[^<]*</heading>`));
    }
    assert.match(styled, /Bugs <danger>1<\/danger>/);
    assert.match(styled, /Sessions <positive>2<\/positive>/);
    assert.match(styled, /<accent>[█░▁-▇ ]+<\/accent>/);
    assert.match(styled, /↻ just now/);
  } finally { await rm(dir, { recursive: true, force: true }); }
});
test('empty lists persist and failed refresh preserves the previous cached list', async () => {
  const dir = await mkdtemp(join(tmpdir(), 'opai-cache-empty-test-'));
  try {
    let calls = 0;
    const cache = () => new ListCache('instance:user', 1000, isSavedQueryList, dir, () => 100);
    assert.deepEqual(await cache().get('queries', async () => { calls++; return []; }), []);
    assert.deepEqual(await cache().get('queries', async () => { calls++; return [{ id: '1', name: 'unexpected' }]; }), []);
    assert.equal(calls, 1);
    await assert.rejects(cache().get('queries', async () => { throw new Error('offline'); }, true));
    assert.deepEqual(await cache().get('queries', async () => { calls++; return [{ id: '1', name: 'unexpected' }]; }), []);
    assert.equal(calls, 1);
  } finally { await rm(dir, { recursive: true, force: true }); }
});
test('saved queries and their results use paginated GET requests without changing filters', async () => {
  const calls: { url: URL; method: string | undefined }[] = [];
  const request = (async (url: string, options?: RequestInit) => {
    const parsed = new URL(url); calls.push({ url: parsed, method: options?.method });
    const page = parsed.searchParams.get('offset');
    const body = parsed.pathname === '/api/v3/queries'
      ? page === '1' ? { total: 2, _embedded: { elements: [{ id: 5, name: 'Sprint' }] } } : { total: 2, _embedded: { elements: [{ id: 6, name: 'Bugs' }] } }
      : page === '1' ? { _embedded: { results: { total: 2, _embedded: { elements: [wp(10, 7)] } } } } : { _embedded: { results: { total: 2, _embedded: { elements: [wp(11, 6)] } } } };
    return { ok: true, json: async () => body };
  }) as unknown as typeof fetch;
  const provider = new OpenProjectProvider(settings, 'secret', request);
  assert.deepEqual(await provider.listSavedQueries(), [{ id: '5', name: 'Sprint' }, { id: '6', name: 'Bugs' }]);
  assert.deepEqual((await provider.listQueryTickets('5')).map(t => t.id), ['10', '11']);
  assert.equal(calls.length, 4);
  assert.ok(calls.every(call => call.method === 'GET' && !call.url.searchParams.has('filters')));
  await assert.rejects(provider.listQueryTickets('../5'));
});
test('ticket rows show ID, title, type, status, and priority without overflowing long titles', () => {
  const ticket = { id: '4521', provider: 'openproject@main', title: 'A very long title that should be cut for a narrow terminal', type: 'Bug' as const, typeLabel: 'Bug', status: 'In progress', priority: { id: '3', name: 'High' } };
  const row = unstyled(ticketRow(ticket, 60));
  assert.match(row, /#4521/);
  assert.match(row, /A very long/);
  assert.match(row, /Bug/);
  assert.match(row, /In progress/);
  assert.match(row, /High/);
  assert.match(row, /…/);
  assert.match(unstyled(ticketRow(ticket, 80, true)), /#4521\s+●\s+/);
});
test('ticket rows align type, status, and priority columns', () => {
  const bug = unstyled(ticketRow({ id: '5', provider: 'openproject@main', title: 'Short', type: 'Bug', typeLabel: 'Bug', status: 'New', priority: { id: '3', name: 'High' } }, 80));
  const story = unstyled(ticketRow({ id: '4521', provider: 'openproject@main', title: 'A substantially longer ticket title', type: 'User Story', typeLabel: 'User Story', status: 'In progress', priority: { id: '4', name: 'Normal' } }, 80));
  assert.match(story, /\bUS\b/);
  assert.doesNotMatch(story, /User Story/);
  assert.equal(bug.indexOf('Bug'), story.indexOf('US'));
  assert.equal(bug.indexOf('New'), story.indexOf('In progress'));
  assert.equal(bug.indexOf('High'), story.indexOf('Normal'));
});
test('selected ticket fills one row without clipping status, and sessions show relative last-opened time', () => {
  const ticket = { id: '4521', provider: 'openproject@main', title: 'Fix charts', type: 'Bug' as const, typeLabel: 'Bug', status: 'Developed' };
  const highlighted = listHighlight(`❯ ${ticketRow(ticket, 60)}`, 60);
  assert.equal(highlighted.split('\n').length, 1);
  assert.match(unstyled(highlighted), /#4521.*Fix charts.*Bug.*Developed/);
  assert.equal(unstyled(highlighted).length, 58);
  const twoLines = listHighlight('❯ #4521  Fix charts\n      Claude · 1 session · last opened 2h ago', 60).split('\n');
  assert.equal(twoLines.length, 2);
  assert.equal(unstyled(twoLines[0]!).length, 58);
  assert.equal(unstyled(twoLines[1]!).length, 58);
  const now = Date.parse('2026-09-22T12:00:00Z');
  assert.equal(sinceLastOpened('2026-09-22T10:00:00Z', now), '2h ago');
  const row = sessionRow({ key: 'openproject@main:4521', id: '4521', title: 'Fix charts', status: 'Developed', lastUsedAt: '2026-09-22T10:00:00Z', sessions: [
    { agent: 'claude', sessionId: '00000000-0000-4000-8000-000000000001', cwd: '/repo', createdAt: '2026-09-22T09:00:00Z' },
    { agent: 'codex', sessionId: '00000000-0000-4000-8000-000000000002', cwd: '/repo', createdAt: '2026-09-22T10:00:00Z' }
  ] }, 80, now);
  assert.match(unstyled(row), /#4521\s+Fix charts.*\[Developed\]\s*\n      Claude \+ Codex · 2 sessions · last opened 2h ago/);
  const other = sessionRow({ key: 'openproject@main:7', id: '7', title: 'A much longer saved ticket title', status: 'New', lastUsedAt: '2026-09-22T10:00:00Z', sessions: [
    { agent: 'claude', sessionId: '00000000-0000-4000-8000-000000000003', cwd: '/repo', createdAt: '2026-09-22T10:00:00Z' }
  ] }, 80, now);
  assert.equal(unstyled(row).indexOf('[Developed]'), unstyled(other).indexOf('[New]'));
});
test('header keeps the full mascot and aligns all adjacent information', () => {
  const header = renderHeader('#4521 A ticket title that is much too long for this terminal', 'Bug · In progress · Priority: High', { kind: 'success', message: 'Ready' }, 58, 'rabbit');
  const lines = header.split('\n');
  assert.equal(lines.length, 3);
  assert.match(lines[0], /\/\) \/\)/);
  assert.match(lines[1], /\(˶ᵔ ᵕ ᵔ˶\)/);
  assert.match(lines[2], /\/づ♡づ/);
  assert.ok(lines.every(line => visibleWidth(line) <= 58));
  const contentColumns = [
    visibleWidth(lines[0].slice(0, lines[0].indexOf('OPAI'))),
    visibleWidth(lines[1].slice(0, lines[1].indexOf('Bug'))),
    visibleWidth(lines[2].slice(0, lines[2].indexOf('✓')))
  ];
  assert.deepEqual(contentColumns, [contentColumns[0], contentColumns[0], contentColumns[0]]);
  assert.match(lines[0], /…$/);
});
test('goodbye uses one compact mascot while keeping the farewell details', () => {
  const goodbye = renderGoodbye('rabbit');
  assert.equal(goodbye.split('\n').length, 2);
  assert.match(goodbye, /₍ᐢ\.\.ᐢ₎♡.*See you next quest, adventurer!/);
  assert.match(goodbye, /Your saved sessions will be here when you return\./);
  assert.doesNotMatch(goodbye, /\/\\_\/\\/);
});
test('header mascot changes by activity without changing content indentation', () => {
  const claude = renderHeader('Start session', 'Claude Code', { kind: 'idle', message: 'Ready' }, 72, 'claude').split('\n');
  const codex = renderHeader('Start session', 'Codex', { kind: 'idle', message: 'Ready' }, 72, 'codex').split('\n');
  assert.notEqual(claude[1].slice(0, claude[1].indexOf('Claude Code')), codex[1].slice(0, codex[1].indexOf('Codex')));
  assert.equal(visibleWidth(claude[0].slice(0, claude[0].indexOf('OPAI'))), visibleWidth(claude[1].slice(0, claude[1].indexOf('Claude Code'))));
  assert.equal(visibleWidth(codex[0].slice(0, codex[0].indexOf('OPAI'))), visibleWidth(codex[1].slice(0, codex[1].indexOf('Codex'))));
});
test('post-agent screen places a cheerful mascot above centered choices', () => {
  const columns = 60;
  const screen = renderAgentClosed('Claude Code session saved for #4521', 'success', columns).split('\n');
  assert.match(screen.join('\n'), /Session closed/);
  assert.match(screen.join('\n'), /session saved for #4521/);
  assert.ok(screen.indexOf(screen.find(line => line.includes('☆'))!) < screen.indexOf(screen.find(line => line.includes('Session closed'))!));
  for (const line of screen.filter(Boolean)) {
    const plain = line.replace(/^ +/, '');
    const left = visibleWidth(line) - visibleWidth(plain);
    assert.ok(Math.abs(left - Math.floor((columns - visibleWidth(plain)) / 2)) <= 1);
  }
  const choices = centeredMenuChoices(['↩  Return to OPAI', '×  Exit to terminal'], columns);
  assert.equal(choices[0]!.indexOf('↩'), choices[1]!.indexOf('×'));
  assert.ok(choices[0]!.indexOf('↩') > 15);
});
test('launch menu shows its selected values and restores focus to the last edited option', () => {
  const menu = buildLaunchMenu('Sonnet', 'High', 'fix openproject bug {{id}}', 'effort');
  assert.equal(menu.default, 'effort');
  assert.deepEqual(menu.choices.map(choice => choice.value), ['start', 'model', 'effort', 'prompt', 'save', 'reset-prompt']);
  assert.match(unstyled(menu.choices[0]!.name), /▶  Start session/);
  assert.match(unstyled(menu.choices[1]!.name), /◈  Model · Sonnet/);
  assert.match(unstyled(menu.choices[2]!.name), /✦  Effort · High/);
  assert.match(unstyled(menu.choices[3]!.name), /✎  Prompt · fix openproject bug \{\{id\}\}/);
  const defaults = buildLaunchMenu('Default', 'Default', 'fix openproject bug {{id}}');
  assert.match(unstyled(defaults.choices[1]!.name), /Model · \(Default\)/);
  assert.match(unstyled(defaults.choices[2]!.name), /Effort · \(Default\)/);
});
test('launch defaults use compact summaries and aligned sections', () => {
  assert.equal(launchDefaultsSummary('Default', 'Default'), 'Agent defaults');
  assert.equal(launchDefaultsSummary('Sonnet', 'High'), 'Sonnet · High effort');
  assert.equal(launchDefaultsSummary('Default', 'High'), 'Agent model · High effort');
  assert.equal(launchDefaultsSummary('gpt-5.3-codex', 'Default'), 'gpt-5.3-codex · Agent effort');
  assert.equal(promptDefaultsSummary(false), 'Provider default');
  assert.equal(promptDefaultsSummary(true), 'Custom');
  const rows = [
    launchDefaultsRow('Claude Code', 'Agent defaults'),
    launchDefaultsRow('Codex', 'gpt-5.3-codex · High effort'),
    launchDefaultsRow('Bug prompt', 'Provider default')
  ];
  assert.deepEqual(rows.map(row => row.indexOf('Agent') >= 0 ? row.indexOf('Agent') : row.indexOf('gpt-5.3-codex') >= 0 ? row.indexOf('gpt-5.3-codex') : row.indexOf('Provider')), [22, 22, 22]);
  const header = menuSectionHeader('Agent defaults', 48);
  assert.equal(visibleWidth(header), 48);
  assert.ok(Math.abs(header.indexOf('Agent defaults') - (48 - 'Agent defaults'.length) / 2) <= 1);
});
test('prompt editing starts with the current template as editable text', () => {
  const config = editablePromptConfig('Initial prompt template', 'fix openproject bug {{id}}');
  assert.equal(config.default, 'fix openproject bug {{id}}');
  assert.equal(config.prefill, 'editable');
  assert.equal(config.validate('fix openproject bug {{id}}'), true);
  assert.match(String(config.validate('missing placeholder')), /must contain \{\{id\}\}/);
});
test('every activity mascot keeps a cheerful expression', () => {
  for (const mood of ['rabbit', 'chick', 'claude', 'codex', 'resume', 'loading', 'success', 'error'] as const) {
    const header = renderHeader('Quest', mood, { kind: mood === 'error' ? 'error' : 'idle', message: 'Ready' }, 72, mood);
    const face = header.split('\n')[1]!;
    assert.match(face, /[ᴗᵔᵕω⩊ᴥө]/, `${mood} mascot should look cheerful`);
    assert.doesNotMatch(face, /[_︿]/, `${mood} mascot should not look upset`);
    assert.doesNotMatch(header, /\/\\_\/\\/, `${mood} should not use the cat mascot`);
  }
});
test('home mascot rotates between the rabbit and chick', async () => {
  const dir = await mkdtemp(join(tmpdir(), 'opai-mascot-rotation-test-'));
  try {
    const path = join(dir, 'ui-state.json');
    const first = await new MascotRotationStore(path).next();
    const second = await new MascotRotationStore(path).next();
    const third = await new MascotRotationStore(path).next();
    const fourth = await new MascotRotationStore(path).next();
    assert.deepEqual([first, second, third, fourth], ['rabbit', 'chick', 'rabbit', 'chick']);
    assert.equal(new Set([first, second, third]).size, 2);
    setIdleMascotMood(second);
    assert.match(renderHeader('Home', 'Browse tickets', { kind: 'idle', message: 'Ready' }, 80), /ө/);
  } finally {
    setIdleMascotMood('rabbit');
    await rm(dir, { recursive: true, force: true });
  }
});
test('selection cursor uses terminal blink when animation is available', () => {
  assert.equal(selectionCursor('❯', true), '\u001b[5m❯\u001b[25m');
  assert.equal(selectionCursor('❯', false), '❯');
});
test('OPAI uses its Catppuccin Mocha RGB palette independently of ANSI theme colors', () => {
  const palette = createOpaiPalette(true);
  assert.equal(palette.accent('x'), '\u001b[38;2;148;226;213mx\u001b[0m');
  assert.equal(palette.mascot('x'), '\u001b[38;2;245;194;231mx\u001b[0m');
  assert.equal(palette.positive('x'), '\u001b[38;2;166;227;161mx\u001b[0m');
  assert.equal(palette.warning('x'), '\u001b[38;2;249;226;175mx\u001b[0m');
  assert.equal(palette.danger('x'), '\u001b[38;2;243;139;168mx\u001b[0m');
  assert.equal(palette.muted('x'), '\u001b[38;2;88;91;112mx\u001b[0m');
  assert.equal(createOpaiPalette(false).accent('x'), 'x');
});
test('Escape and Left Arrow return from menus while Backspace remains a text-editing key', async () => {
  assert.equal(isQuickBackKey({ name: 'left' }), true);
  assert.equal(isQuickBackKey({ name: 'backspace' }), false);
  assert.equal(isQuickBackKey({ name: 'c', ctrl: true }), false);
  for (const name of ['escape', 'left']) {
    const input = new EventEmitter();
    const prompt = promptWithBack<string>(signal => new Promise((_, reject) => {
      signal.addEventListener('abort', () => reject(Object.assign(new Error('aborted'), { name: 'AbortPromptError' })));
    }), input);
    input.emit('keypress', '', { name });
    assert.equal(await prompt, BACK);
    assert.equal(input.listenerCount('keypress'), 0);
  }
  const input = new EventEmitter();
  const second = await promptWithBack(async () => {
    input.emit('keypress', '\u0003', { name: 'c', ctrl: true });
    return 'still here';
  }, input);
  assert.equal(second, 'still here');
  const editing = await promptWithBack(async () => {
    input.emit('keypress', '', { name: 'backspace' });
    return 'editing continues';
  }, input);
  assert.equal(editing, 'editing continues');
  const movingCursor = await promptWithBack(async () => {
    input.emit('keypress', '', { name: 'left' });
    return 'cursor moves';
  }, input, { quickBack: false });
  assert.equal(movingCursor, 'cursor moves');
});
test('API token persists with owner-only permissions and environment override', async () => {
  const dir = await mkdtemp(join(tmpdir(), 'opai-token-test-'));
  const path = join(dir, 'token');
  try {
    assert.equal(await loadApiToken(path, ''), undefined);
    await assert.rejects(saveApiToken('', path));
    await saveApiToken('stored-secret', path);
    assert.equal(await loadApiToken(path, ''), 'stored-secret');
    assert.equal((await stat(path)).mode & 0o777, 0o600);
    assert.equal(await loadApiToken(path, 'environment-secret'), 'environment-secret');
    await saveApiToken('rotated-secret', path);
    assert.equal(await loadApiToken(path, ''), 'rotated-secret');
  } finally { await rm(dir, { recursive: true, force: true }); }
});
test('request status reports loading, success, and failure', async () => {
  const writes: string[] = [];
  const bar = new StatusBar({ write: chunk => { writes.push(chunk); }, isTTY: false });
  assert.equal(await bar.run('tickets', async () => 3, count => `${count} tickets loaded`), 3);
  assert.deepEqual(bar.current, { kind: 'success', message: '3 tickets loaded' });
  await assert.rejects(bar.run('tickets', async () => { throw new Error('offline'); }, () => 'loaded'));
  assert.deepEqual(bar.current, { kind: 'error', message: 'tickets failed' });
  assert.deepEqual(writes, ['Loading tickets...\n', 'Loading tickets...\n']);
});
test('query pins and recents persist and sort ahead of other queries', async () => {
  const dir = await mkdtemp(join(tmpdir(), 'opai-query-prefs-test-'));
  try {
    const path = join(dir, 'queries.json');
    const store = new QueryPreferencesStore(path, () => new Date('2026-09-22T10:00:00Z'));
    const queries = [{ id: '1', name: 'Alpha' }, { id: '2', name: 'Beta' }, { id: '3', name: 'Gamma' }];
    await store.opened('openproject@main', '3');
    assert.deepEqual(orderedQueries(queries, await new QueryPreferencesStore(path).all(), 'openproject@main').map(q => q.id), ['3', '1', '2']);
    assert.equal(await store.togglePin('openproject@main', '2'), true);
    assert.deepEqual(orderedQueries(queries, await store.all(), 'openproject@main').map(q => q.id), ['2', '3', '1']);
    assert.equal(await store.togglePin('openproject@main', '2'), false);
    assert.deepEqual(orderedQueries(queries, await store.all(), 'other-instance').map(q => q.id), ['1', '2', '3']);
  } finally { await rm(dir, { recursive: true, force: true }); }
});
test('saved queries are grouped into pinned, recently viewed, and all-query sections', () => {
  const queries = [
    { id: '1', name: 'Alpha' },
    { id: '2', name: 'Beta' },
    { id: '3', name: 'Gamma' },
    { id: '4', name: 'Delta' }
  ];
  const preferences = {
    'openproject@main:2': { pinned: false, lastOpenedAt: '2026-09-22T09:00:00Z' },
    'openproject@main:3': { pinned: true, lastOpenedAt: '2026-09-22T08:00:00Z' },
    'openproject@main:4': { pinned: false, lastOpenedAt: '2026-09-22T10:00:00Z' }
  };
  const sections = querySections(queries, preferences, 'openproject@main');
  assert.deepEqual(sections.map(section => [section.kind, section.queries.map(query => query.id)]), [
    ['pinned', ['3']],
    ['recent', ['4', '2']],
    ['all', ['1']]
  ]);
  assert.deepEqual(querySections(queries.slice(0, 1), preferences, 'openproject@main').map(section => section.kind), ['all']);
});
test('saved sessions group by ticket and keep old records usable without API data', async () => {
  const earlier = '2026-09-21T10:00:00Z';
  const later = '2026-09-22T10:00:00Z';
  const records = {
    'openproject@main:5': [
      { agent: 'claude' as const, sessionId: '00000000-0000-4000-8000-000000000001', cwd: '/repo', createdAt: earlier },
      { agent: 'codex' as const, sessionId: '00000000-0000-4000-8000-000000000002', cwd: '/repo', createdAt: later, ticket: { id: '5', provider: 'openproject@main', title: 'Fix charts', type: 'Bug' as const, typeLabel: 'Bug', status: 'Open', priority: { id: '3', name: 'High' } } }
    ],
    'openproject@main:6': [{ agent: 'claude' as const, sessionId: '00000000-0000-4000-8000-000000000003', cwd: '/repo', createdAt: earlier }],
    'openproject@other:7': [{ agent: 'claude' as const, sessionId: '00000000-0000-4000-8000-000000000004', cwd: '/repo', createdAt: later }]
  };
  const groups = sessionTickets(records, 'openproject@main');
  assert.deepEqual(groups.map(g => [g.id, g.title, g.sessions.length]), [['5', 'Fix charts', 2], ['6', 'Ticket #6', 1]]);
  assert.equal(groups[0].sessions[0].agent, 'codex');
  assert.equal(groups[0].status, 'Open');
  assert.doesNotMatch(unstyled(sessionRow(groups[0])), /High/);
  assert.equal(groups[1].status, undefined);
  assert.match(unstyled(sessionRow(groups[1])), /Status unavailable/);
});
