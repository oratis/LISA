/**
 * ANSI colour for CLI output — hand-rolled, because the project policy is "no
 * chalk-class dependencies" for a handful of escape codes.
 *
 * One decision function, `colorEnabled()`, is the single source of truth for
 * "may this stream carry colour?": `--no-color` beats everything, then the
 * NO_COLOR convention (https://no-color.org: any non-empty value disables),
 * then TERM=dumb, and finally the stream has to be an interactive terminal —
 * piped or redirected output is always plain so `lisa … | grep` and log files
 * never see escape codes. stdout and stderr are decided separately: a user
 * running `lisa "…" > answer.md` still gets a coloured tool trace on the
 * terminal while the file stays clean.
 */

export interface Palette {
  readonly enabled: boolean;
  dim(s: string): string;
  bold(s: string): string;
  red(s: string): string;
  green(s: string): string;
  yellow(s: string): string;
  cyan(s: string): string;
  grey(s: string): string;
}

/** Process-wide override set by `--no-color`; null means "decide per stream". */
let override: boolean | null = null;

export function setColorOverride(value: boolean | null): void {
  override = value;
}

export function colorEnabled(
  opts: { isTTY?: boolean; env?: NodeJS.ProcessEnv; noColorFlag?: boolean } = {},
): boolean {
  if (opts.noColorFlag) return false;
  if (override !== null) return override;
  const env = opts.env ?? process.env;
  if (env.NO_COLOR != null && env.NO_COLOR !== "") return false;
  if (env.TERM === "dumb") return false;
  return opts.isTTY === true;
}

function wrap(enabled: boolean, open: number, close: number): (s: string) => string {
  if (!enabled) return (s) => s;
  return (s) => `\x1b[${open}m${s}\x1b[${close}m`;
}

export function makePalette(enabled: boolean): Palette {
  return {
    enabled,
    dim: wrap(enabled, 2, 22),
    bold: wrap(enabled, 1, 22),
    red: wrap(enabled, 31, 39),
    green: wrap(enabled, 32, 39),
    yellow: wrap(enabled, 33, 39),
    cyan: wrap(enabled, 36, 39),
    grey: wrap(enabled, 90, 39),
  };
}

/** The identity palette — handy for tests and for streams decided as plain. */
export const PLAIN: Palette = makePalette(false);

/** Length of a string as the terminal shows it (escape sequences excluded). */
export function visibleLength(s: string): number {
  // eslint-disable-next-line no-control-regex
  return s.replace(/\x1b\[[0-9;]*[A-Za-z]/g, "").length;
}
