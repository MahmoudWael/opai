import { randomUUID } from 'node:crypto';
import { mkdir, readFile, rename, writeFile } from 'node:fs/promises';
import { dirname, join } from 'node:path';
import { configDir } from './config.js';
import type { IdleMascotMood } from './ui.js';

const rotation: readonly IdleMascotMood[] = ['rabbit', 'chick'];

interface UiState {
  nextMascotIndex: number;
}

/** Normalizes persisted mascot state to a valid rotation index. */
function nextIndex(value: unknown): number {
  if (!value || typeof value !== 'object' || Array.isArray(value)) return 0;
  const index = (value as Partial<UiState>).nextMascotIndex;
  return Number.isInteger(index) && Number(index) >= 0 ? Number(index) % rotation.length : 0;
}

export class MascotRotationStore {
  /** Creates a mascot rotation store backed by the supplied JSON file. */
  constructor(readonly path = join(configDir, 'ui-state.json')) {}

  /** Returns the next mascot and atomically advances the persisted rotation. */
  async next(): Promise<IdleMascotMood> {
    let index = 0;
    try { index = nextIndex(JSON.parse(await readFile(this.path, 'utf8'))); }
    catch { /* First launch or invalid state starts with the rabbit. */ }
    const mascot = rotation[index]!;
    try {
      await mkdir(dirname(this.path), { recursive: true, mode: 0o700 });
      const temp = `${this.path}.${randomUUID()}.tmp`;
      await writeFile(temp, `${JSON.stringify({ nextMascotIndex: (index + 1) % rotation.length }, null, 2)}\n`, { mode: 0o600 });
      await rename(temp, this.path);
    } catch { /* Mascot decoration must never prevent OPAI from starting. */ }
    return mascot;
  }
}
