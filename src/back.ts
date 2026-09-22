export const BACK = Symbol('back');

export async function promptWithBack<T>(prompt: (signal: AbortSignal) => Promise<T>, input: NodeJS.EventEmitter = process.stdin): Promise<T | typeof BACK> {
  const controller = new AbortController();
  const onKeypress = (_value: string, key?: { name?: string }) => {
    if (key?.name === 'escape') controller.abort(BACK);
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
