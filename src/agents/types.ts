export type Agent = 'claude' | 'codex';
export interface LaunchSpec { executable: string; args: string[]; cwd: string }
