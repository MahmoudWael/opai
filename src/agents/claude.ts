import type { LaunchSpec } from './types.js';
import { createReadStream } from 'node:fs';
import { readdir, stat } from 'node:fs/promises';
import { createInterface } from 'node:readline';
import { homedir } from 'node:os';
import { join } from 'node:path';

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
const defaultRoot = () => join(process.env.CLAUDE_CONFIG_DIR ?? join(homedir(), '.claude'), 'projects');
export interface NativeSessionCandidate { agent: 'claude' | 'codex'; sessionId: string; cwd: string; createdAt: string }
async function projectFiles(root: string): Promise<string[]> {
  let projects;
  try { projects = await readdir(root, { withFileTypes: true }); } catch { return []; }
  const groups = await Promise.all(projects.filter(item => item.isDirectory()).map(async project => {
    const dir = join(root, project.name);
    try { return (await readdir(dir)).filter(name => name.endsWith('.jsonl')).map(name => join(dir, name)); }
    catch { return []; }
  }));
  return groups.flat();
}
export async function nativeClaudeSessionExists(id: string, root = defaultRoot()): Promise<boolean> {
  if (!UUID.test(id)) return false;
  return (await projectFiles(root)).some(path => path.endsWith(`/${id}.jsonl`));
}
async function firstPrompt(path: string): Promise<{ prompt: string; sessionId: string; cwd: string; createdAt: string } | undefined> {
  const stream = createReadStream(path, { encoding: 'utf8' });
  const lines = createInterface({ input: stream, crlfDelay: Infinity });
  try {
    for await (const line of lines) {
      let event: { type?: string; sessionId?: string; cwd?: string; timestamp?: string; message?: { content?: unknown } };
      try { event = JSON.parse(line); } catch { continue; }
      if (event.type !== 'user') continue;
      const content = event.message?.content;
      const prompt = typeof content === 'string' ? content : Array.isArray(content) ? content.find(part => part?.type === 'text' && typeof part.text === 'string')?.text : undefined;
      if (typeof prompt !== 'string') continue;
      if (!event.sessionId || !UUID.test(event.sessionId) || !event.cwd) return undefined;
      const createdAt = event.timestamp && Number.isFinite(Date.parse(event.timestamp)) ? event.timestamp : (await stat(path)).mtime.toISOString();
      return { prompt, sessionId: event.sessionId, cwd: event.cwd, createdAt };
    }
  } finally { lines.close(); stream.destroy(); }
  return undefined;
}
export async function findClaudeTicketSessions(prompt: string, root = defaultRoot()): Promise<NativeSessionCandidate[]> {
  const files = await projectFiles(root);
  const candidates = await Promise.all(files.map(async path => {
    try {
      const first = await firstPrompt(path);
      return first?.prompt === prompt && path.endsWith(`/${first.sessionId}.jsonl`) ? { agent: 'claude' as const, sessionId: first.sessionId, cwd: first.cwd, createdAt: first.createdAt } : undefined;
    } catch { return undefined; }
  }));
  return candidates.filter((candidate): candidate is NonNullable<typeof candidate> => candidate !== undefined);
}
export function claudeLaunch(executable: string, cwd: string, prompt: string, id: string): LaunchSpec { return { executable, cwd, args: ['--session-id', id, prompt] }; }
export function claudeResume(executable: string, cwd: string, id: string): LaunchSpec { return { executable, cwd, args: ['--resume', id] }; }
