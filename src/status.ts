export type StatusKind = 'idle' | 'cached' | 'loading' | 'success' | 'error';
export interface Status { kind: StatusKind; message: string }

const faces = ['(˶• ᴗ •˶)⋯', '(˶ᵔ ᴗ ᵔ˶)⌕', '(˶• ⩊ •˶)✧'];
const spinners = ['⠋', '⠙', '⠹', '⠸', '⠼', '⠴', '⠦', '⠧'];

export class StatusBar {
  current: Status = { kind: 'idle', message: 'Ready for your next quest' };
  /** Creates a status bar that writes to a terminal-like output stream. */
  constructor(private readonly output: {
    /** Writes one status-bar output chunk. */
    write(chunk: string): unknown;
    isTTY?: boolean;
  } = process.stdout) {}
  /** Replaces the current status shown by subsequent screens. */
  set(kind: StatusKind, message: string): void { this.current = { kind, message }; }
  /** Runs asynchronous work with an animated loading state and final status. */
  async run<T>(label: string, work: () => Promise<T>, success: (value: T) => string): Promise<T> {
    this.set('loading', label);
    let frame = 0;
    /** Draws one frame of the inline loading animation. */
    const draw = () => {
      this.output.write(`\r\u001b[2K  ${faces[frame % faces.length]}  ${spinners[frame % spinners.length]} ${label}`);
      frame++;
    };
    if (this.output.isTTY) draw();
    else this.output.write(`Loading ${label}...\n`);
    const timer = this.output.isTTY ? setInterval(draw, 120) : undefined;
    try {
      const value = await work();
      this.set('success', success(value));
      return value;
    } catch (error) {
      this.set('error', `${label} failed`);
      throw error;
    } finally {
      if (timer) clearInterval(timer);
      if (this.output.isTTY) this.output.write('\r\u001b[2K');
    }
  }
}

export const statusBar = new StatusBar();
