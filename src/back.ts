export const BACK = Symbol('back');

/** Reports whether a key should trigger fast backward navigation. */
export function isQuickBackKey(key?: { name?: string; ctrl?: boolean }): boolean {
  return key?.name === 'left';
}

/** Runs an Inquirer prompt with Escape and optional quick-back cancellation. */
export async function promptWithBack<T>(
  prompt: (signal: AbortSignal) => Promise<T>,
  input: NodeJS.EventEmitter = process.stdin,
  options: { quickBack?: boolean } = {}
): Promise<T | typeof BACK> {
  const controller = new AbortController();
  /** Converts supported navigation keys into prompt cancellation. */
  const onKeypress = (_value: string, key?: { name?: string }) => {
    if (key?.name === 'escape' || options.quickBack !== false && isQuickBackKey(key)) controller.abort(BACK);
  };
  input.on('keypress', onKeypress);
  try {
    return await prompt(controller.signal);
  } catch (error) {
    if (controller.signal.reason === BACK && error instanceof Error && error.name === 'AbortPromptError') return BACK;
    throw error;
  } finally {
    input.off('keypress', onKeypress);
  }
}
