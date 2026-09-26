import type { LaunchSpec } from './types.js';
import { createReadStream } from 'node:fs';
import { readdir, stat } from 'node:fs/promises';
import { createInterface } from 'node:readline';
import { homedir } from 'node:os';
import { join } from 'node:path';

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
/** Returns Claude Code's native project-session directory. */
const defaultRoot = () => join(process.env.CLAUDE_CONFIG_DIR ?? join(homedir(), '.claude'), 'projects');
export interface NativeSessionCandidate { agent: 'claude' | 'codex'; sessionId: string; cwd: string; createdAt: string }
/** Lists Claude JSONL session files below the configured projects directory. */
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
/** Checks whether a native Claude session with the supplied UUID exists. */
export async function nativeClaudeSessionExists(id: string, root = defaultRoot()): Promise<boolean> {
  if (!UUID.test(id)) return false;
  return (await projectFiles(root)).some(path => path.endsWith(`/${id}.jsonl`));
}
/** Reads the first user prompt and identifying metadata from a Claude session. */
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
/** Finds native Claude sessions whose first prompt exactly matches a ticket prompt. */
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
/** Builds an interactive Claude launch specification with optional model settings. */
export function claudeLaunch(executable: string, cwd: string, prompt: string, id: string, model: string | null = null, effort: string | null = null): LaunchSpec { return { executable, cwd, args: ['--session-id', id, ...(model ? ['--model', model] : []), ...(effort ? ['--effort', effort] : []), prompt] }; }
/** Builds a launch specification that resumes an exact native Claude session. */
export function claudeResume(executable: string, cwd: string, id: string): LaunchSpec { return { executable, cwd, args: ['--resume', id] }; }
