/**
 * Tiny zero-dep ANSI color helpers.
 *
 * Project policy is "no chalk-class CLI deps" so this module rolls its own.
 * Every function checks if stdout is a TTY and respects NO_COLOR env;
 * non-TTY / piped / NO_COLOR=1 output is plain text.
 */

const NO_COLOR =
  process.env.NO_COLOR != null && process.env.NO_COLOR !== "" && process.env.NO_COLOR !== "0";

function supportsColor(): boolean {
  if (NO_COLOR) return false;
  return process.stdout.isTTY === true;
}

function wrap(open: number, close: number) {
  return (s: string): string => {
    if (!supportsColor()) return s;
    return `\x1b[${open}m${s}\x1b[${close}m`;
  };
}

// Foreground colors (30-37, bright 90-97)
export const dim = wrap(2, 22);
export const bold = wrap(1, 22);
export const italic = wrap(3, 23);
export const underline = wrap(4, 24);

export const red = wrap(31, 39);
export const green = wrap(32, 39);
export const yellow = wrap(33, 39);
export const blue = wrap(34, 39);
export const magenta = wrap(35, 39);
export const cyan = wrap(36, 39);
export const grey = wrap(90, 39);

export const greenBg = wrap(42, 49);
export const yellowBg = wrap(43, 49);
export const redBg = wrap(41, 49);

/** Status badges: ✓ green, ✗ red, ⚠ yellow, • dim. */
export const ok = (s: string): string => green("✓ " + s);
export const fail = (s: string): string => red("✗ " + s);
export const warn = (s: string): string => yellow("⚠ " + s);
export const note = (s: string): string => dim("• " + s);

/** Box-drawing helpers for sectioned output. */
export function rule(label?: string, width = 60): string {
  if (!label) return grey("─".repeat(width));
  const padded = ` ${label} `;
  const left = 4;
  const right = Math.max(0, width - left - padded.length);
  return grey("─".repeat(left)) + cyan(padded) + grey("─".repeat(right));
}

export function heading(label: string): string {
  return "\n" + bold(cyan(label)) + "\n" + grey("─".repeat(label.length));
}
