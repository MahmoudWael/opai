import { readdir, open } from 'node:fs/promises';
import { join } from 'node:path';
import { homedir } from 'node:os';
import type { LaunchSpec } from './types.js';
import type { NativeSessionCandidate } from './claude.js';
export function codexLaunch(executable: string, cwd: string, prompt: string): LaunchSpec { return { executable, cwd, args: [prompt] }; }
export function codexResume(executable: string, cwd: string, id: string): LaunchSpec { return { executable, cwd, args: ['resume', id] }; }
const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
async function filesBelow(dir: string): Promise<string[]> {
  let entries;
  try { entries = await readdir(dir, { withFileTypes: true }); } catch { return []; }
  const nested = await Promise.all(entries.map(async entry => entry.isDirectory() ? filesBelow(join(dir, entry.name)) : entry.name.endsWith('.jsonl') ? [join(dir, entry.name)] : []));
  return nested.flat();
}
async function metadata(path: string): Promise<{ id: string; cwd: string; prompt?: string; createdAt: string } | undefined> {
  const file = await open(path, 'r');
  try {
    const content = await file.readFile('utf8');
    const lines = content.split('\n');
    const first = JSON.parse(lines[0] ?? '{}') as { type?: string; payload?: { id?: string; session_id?: string; cwd?: string; timestamp?: string } };
    if (first.type !== 'session_meta') return undefined;
    const id = first.payload?.id ?? first.payload?.session_id;
    if (!id || !UUID.test(id) || !first.payload?.cwd) return undefined;
    const messages = lines.slice(1).map(line => { try { return JSON.parse(line) as { type?: string; payload?: { type?: string; role?: string; content?: { type?: string; text?: string }[]; message?: string } }; } catch { return undefined; } });
    const prompts = messages.filter(event => (event?.type === 'event_msg' && event.payload?.type === 'user_message') || (event?.type === 'response_item' && event.payload?.type === 'message' && event.payload.role === 'user')).map(event => event?.payload?.message ?? event?.payload?.content?.find(part => part.type === 'input_text')?.text).filter((value): value is string => typeof value === 'string' && !value.startsWith('<environment_context>'));
    return { id, cwd: first.payload.cwd, prompt: prompts[0], createdAt: first.payload.timestamp && Number.isFinite(Date.parse(first.payload.timestamp)) ? first.payload.timestamp : new Date().toISOString() };
  } finally { await file.close(); }
}
export async function codexSessionFiles(root = join(process.env.CODEX_HOME ?? join(homedir(), '.codex'), 'sessions')): Promise<Map<string, string>> {
  const files = await filesBelow(root);
  return new Map(files.map(path => [path, path]));
}
export async function identifyCodexSession(before: Map<string, string>, after: Map<string, string>, cwd: string, prompt: string): Promise<string | undefined> {
  const candidates = await Promise.all([...after.keys()].filter(path => !before.has(path)).map(metadata));
  const matches = candidates.filter(item => item?.cwd === cwd && item.prompt === prompt);
  return matches.length === 1 ? matches[0]!.id : undefined;
}
export async function findCodexTicketSessions(prompt: string, root = join(process.env.CODEX_HOME ?? join(homedir(), '.codex'), 'sessions')): Promise<NativeSessionCandidate[]> {
  const candidates = await Promise.all((await filesBelow(root)).map(async path => {
    try {
      const item = await metadata(path);
      return item?.prompt === prompt && path.endsWith(`${item.id}.jsonl`) ? { agent: 'codex' as const, sessionId: item.id, cwd: item.cwd, createdAt: item.createdAt } : undefined;
    } catch { return undefined; }
  }));
  return candidates.filter((item): item is NonNullable<typeof item> => item !== undefined);
}
export async function nativeCodexSessionExists(id: string, root = join(process.env.CODEX_HOME ?? join(homedir(), '.codex'), 'sessions')): Promise<boolean> {
  if (!UUID.test(id)) return false;
  const files = await filesBelow(root);
  return files.some(path => path.endsWith(`${id}.jsonl`));
}
