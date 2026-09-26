import { spawn, type ChildProcess } from 'node:child_process';
import type { LaunchSpec } from './types.js';
/** Runs an agent interactively and resolves with its normalized exit code. */
export async function runAgent(spec: LaunchSpec, onRunning?: () => Promise<void>, spawnProcess: typeof spawn = spawn): Promise<number> {
  return new Promise((resolve, reject) => {
    let child: ChildProcess;
    try { child = spawnProcess(spec.executable, spec.args, { cwd: spec.cwd, stdio: 'inherit', shell: false }); }
    catch (error) { reject(error); return; }
    // Ctrl+C reaches both processes in the foreground group. Let the agent handle
    // its signal, while OPAI remains alive long enough to record the session.
    /** Keeps OPAI alive while the foreground agent handles Ctrl+C. */
    const onSigint = () => {};
    process.on('SIGINT', onSigint);
    let pending = Promise.resolve();
    const timer = onRunning ? setInterval(() => {
      pending = pending.then(onRunning).catch(() => {});
    }, 1000) : undefined;
    /** Removes polling and signal handlers after the agent exits. */
    const cleanup = () => { if (timer) clearInterval(timer); process.off('SIGINT', onSigint); };
    child.once('error', error => { cleanup(); reject(error); });
    child.once('exit', (code, signal) => {
      cleanup();
      void pending.then(() => resolve(code ?? (signal === 'SIGINT' ? 130 : 1)));
    });
  });
}
