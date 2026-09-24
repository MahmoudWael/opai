import { constants } from 'node:fs';
import { chmod, copyFile, mkdir, readFile, writeFile } from 'node:fs/promises';
import { dirname } from 'node:path';

export type CliCommand =
  | { kind: 'interactive' | 'mine' | 'help' | 'version' | 'init' }
  | { kind: 'show' | 'resume'; id: string };

export const cliHelp = `OPAI — browse tickets and resume coding-agent sessions

Usage:
  opai                  Open the interactive dashboard
  opai mine             Browse assigned tickets
  opai show <id>        Open one ticket
  opai resume <id>      Resume a saved ticket session
  opai init             Create the sample configuration
  opai --help           Show this help
  opai --version        Show the installed version
`;

export function parseCliCommand(args: string[]): CliCommand {
  if (!args.length) return { kind: 'interactive' };
  if (args.length === 1 && ['--help', '-h'].includes(args[0]!)) return { kind: 'help' };
  if (args.length === 1 && ['--version', '-v'].includes(args[0]!)) return { kind: 'version' };
  if (args.length === 1 && args[0] === 'init') return { kind: 'init' };
  if (args.length === 1 && args[0] === 'mine') return { kind: 'mine' };
  if (args[0] === 'show' || args[0] === 'resume') {
    if (!args[1]) throw new Error('Ticket ID required.');
    if (args.length !== 2) throw new Error('Usage: opai [mine | show <id> | resume <id> | init | --help | --version]');
    return { kind: args[0], id: args[1] };
  }
  throw new Error('Usage: opai [mine | show <id> | resume <id> | init | --help | --version]');
}

export async function packageVersion(packageUrl = new URL('../package.json', import.meta.url)): Promise<string> {
  const value = JSON.parse(await readFile(packageUrl, 'utf8')) as { version?: unknown };
  if (typeof value.version !== 'string') throw new Error('Could not read the installed OPAI version.');
  return value.version;
}

export async function initializeConfig(destination: string, contents?: string): Promise<void> {
  await mkdir(dirname(destination), { recursive: true, mode: 0o700 });
  try {
    if (contents === undefined) await copyFile(new URL('../config.example.json', import.meta.url), destination, constants.COPYFILE_EXCL);
    else await writeFile(destination, contents, { flag: 'wx', mode: 0o600 });
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === 'EEXIST') throw new Error(`Configuration already exists at ${destination}.`);
    throw error;
  }
  await chmod(destination, 0o600);
}
