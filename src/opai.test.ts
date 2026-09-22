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
import { ListCache, isSavedQueryList, isTicketList } from './list-cache.js';
import { listHighlight, sessionRow, sinceLastOpened, ticketRow } from './ui.js';
import { loadApiToken, saveApiToken } from './token.js';
import { StatusBar } from './status.js';
import { QueryPreferencesStore, orderedQueries } from './query-preferences.js';
import { EventEmitter } from 'node:events';
import { BACK, promptWithBack } from './back.js';
import { syncSessionTickets } from './sessions/sync.js';
import { DashboardHistoryStore, buildDashboard, renderDashboard } from './dashboard.js';
const settings = { url: 'https://example.test', instanceId: 'main', bugTypeId: 7, userStoryTypeId: 6 };
const wp = (id: number, type: number, name = 'Bug') => ({ id, subject: `Ticket ${id}`, _links: { type: { href: `/api/v3/types/${type}`, title: name }, status: { href: '/api/v3/statuses/4', title: 'In progress' } } });
test('OpenProject paginates, filters assigned open tickets, and normalizes stable type IDs', async () => {
  const calls: URL[] = [];
  const request = (async (url: string) => { const parsed = new URL(url); calls.push(parsed); const body = parsed.pathname.endsWith('/users/me') ? { id: 42 } : parsed.searchParams.get('offset') === '1' ? { total: 2, count: 1, offset: 1, _embedded: { elements: [wp(5, 7)] } } : { total: 2, count: 1, offset: 2, _embedded: { elements: [wp(6, 6, 'User Story')] } }; return { ok: true, json: async () => body }; }) as unknown as typeof fetch;
  const provider = new OpenProjectProvider(settings, 'secret', request);
  const tickets = await provider.listAssigned();
  assert.deepEqual(tickets.map(x => x.type), ['Bug', 'User Story']);
  assert.deepEqual(JSON.parse(calls[1].searchParams.get('filters')!), [{ assignee: { operator: '=', values: ['42'] } }, { status: { operator: 'o', values: [] } }]);
  assert.equal(calls[2].searchParams.get('offset'), '2');
  assert.equal(provider.prompt(tickets[0], 'fix'), 'fix openproject bug 5');
  assert.equal(provider.prompt(tickets[1], 'implement'), 'implement openproject user story 6');
  assert.equal(provider.normalize(wp(7, 99)).type, 'Unsupported');
  assert.equal(provider.normalize(wp(7, 99)).typeLabel, 'Bug');
  assert.throws(() => provider.prompt(provider.normalize(wp(7, 99)), 'fix'));
  assert.equal(ticketKey(tickets[0]), 'openproject@main:5');
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
  assert.deepEqual(claudeResume('claude', '/repo', id).args, ['--resume', id]);
  assert.deepEqual(codexLaunch('codex', '/repo', 'fix openproject bug 5').args, ['fix openproject bug 5']);
  assert.deepEqual(codexResume('codex', '/repo', id).args, ['resume', id]);
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
test('ticket rows show ID, title, type, and status without overflowing long titles', () => {
  const ticket = { id: '4521', provider: 'openproject@main', title: 'A very long title that should be cut for a narrow terminal', type: 'Bug' as const, typeLabel: 'Bug', status: 'In progress' };
  const row = ticketRow(ticket, 60);
  assert.match(row, /#4521/);
  assert.match(row, /A very long/);
  assert.match(row, /Bug/);
  assert.match(row, /In progress/);
  assert.match(row, /…/);
});
test('selected ticket fills one row without clipping status, and sessions show relative last-opened time', () => {
  const ticket = { id: '4521', provider: 'openproject@main', title: 'Fix charts', type: 'Bug' as const, typeLabel: 'Bug', status: 'Developed' };
  const highlighted = listHighlight(`❯ ${ticketRow(ticket, 60)}`, 60);
  assert.equal(highlighted.split('\n').length, 1);
  assert.match(highlighted, /#4521.*Fix charts.*Bug.*Developed/);
  assert.equal(highlighted.replace(/\u001b\[[0-9;]*m/g, '').length, 58);
  const twoLines = listHighlight('❯ #4521  Fix charts\n      Claude · 1 session · last opened 2h ago', 60).split('\n');
  assert.equal(twoLines.length, 2);
  assert.equal(twoLines[0].replace(/\u001b\[[0-9;]*m/g, '').length, 58);
  assert.equal(twoLines[1].replace(/\u001b\[[0-9;]*m/g, '').length, 58);
  const now = Date.parse('2026-09-22T12:00:00Z');
  assert.equal(sinceLastOpened('2026-09-22T10:00:00Z', now), '2h ago');
  const row = sessionRow({ key: 'openproject@main:4521', id: '4521', title: 'Fix charts', status: 'Developed', lastUsedAt: '2026-09-22T10:00:00Z', sessions: [
    { agent: 'claude', sessionId: '00000000-0000-4000-8000-000000000001', cwd: '/repo', createdAt: '2026-09-22T09:00:00Z' },
    { agent: 'codex', sessionId: '00000000-0000-4000-8000-000000000002', cwd: '/repo', createdAt: '2026-09-22T10:00:00Z' }
  ] }, 80, now);
  assert.match(row, /#4521  Fix charts.*\[Developed\]\n      Claude \+ Codex · 2 sessions · last opened 2h ago/);
});
test('Escape returns from a prompt without treating Ctrl+C as Back', async () => {
  const input = new EventEmitter();
  const prompt = promptWithBack<string>(signal => new Promise((_, reject) => {
    signal.addEventListener('abort', () => reject(Object.assign(new Error('aborted'), { name: 'AbortPromptError' })));
  }), input);
  input.emit('keypress', '\u001b', { name: 'escape' });
  assert.equal(await prompt, BACK);
  assert.equal(input.listenerCount('keypress'), 0);
  const second = await promptWithBack(async () => {
    input.emit('keypress', '\u0003', { name: 'c', ctrl: true });
    return 'still here';
  }, input);
  assert.equal(second, 'still here');
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
test('saved sessions group by ticket and keep old records usable without API data', async () => {
  const earlier = '2026-09-21T10:00:00Z';
  const later = '2026-09-22T10:00:00Z';
  const records = {
    'openproject@main:5': [
      { agent: 'claude' as const, sessionId: '00000000-0000-4000-8000-000000000001', cwd: '/repo', createdAt: earlier },
      { agent: 'codex' as const, sessionId: '00000000-0000-4000-8000-000000000002', cwd: '/repo', createdAt: later, ticket: { id: '5', provider: 'openproject@main', title: 'Fix charts', type: 'Bug' as const, typeLabel: 'Bug', status: 'Open' } }
    ],
    'openproject@main:6': [{ agent: 'claude' as const, sessionId: '00000000-0000-4000-8000-000000000003', cwd: '/repo', createdAt: earlier }],
    'openproject@other:7': [{ agent: 'claude' as const, sessionId: '00000000-0000-4000-8000-000000000004', cwd: '/repo', createdAt: later }]
  };
  const groups = sessionTickets(records, 'openproject@main');
  assert.deepEqual(groups.map(g => [g.id, g.title, g.sessions.length]), [['5', 'Fix charts', 2], ['6', 'Ticket #6', 1]]);
  assert.equal(groups[0].sessions[0].agent, 'codex');
  assert.equal(groups[0].status, 'Open');
  assert.equal(groups[1].status, undefined);
  assert.match(sessionRow(groups[1]), /Status unavailable/);
});
