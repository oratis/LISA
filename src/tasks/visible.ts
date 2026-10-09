/**
 * Text the user is shown about a task, as it is — nothing in it can change
 * what the screen looks like (#422 review NEW-1).
 *
 * Every string a task carries came from somewhere the user does not control
 * (the model drafted it, a client sent it, a file was edited). Printed raw, a
 * control character can clear the terminal and draw a different task over the
 * real one; a bidi control or an invisible character can make the text read
 * differently from what it is. `visible()` shows such characters escaped, so
 * the screen is the text.
 */

/**
 * Characters that would change what the user sees without being seen: C0 and
 * C1 controls (an escape sequence, a carriage return, a backspace), bidi
 * controls and every other format character (zero-width spaces and joiners,
 * tags, the BOM), line and paragraph separators, lone surrogates, and the
 * letters that render as nothing (the Hangul fillers).
 */
const UNSEEN_CLASS = "[\\p{Cc}\\p{Cf}\\p{Zl}\\p{Zp}\\p{Cs}\\u115F\\u1160\\u3164\\uFFA0]";
const UNSEEN = new RegExp(UNSEEN_CLASS, "gu");
const HAS_UNSEEN = new RegExp(UNSEEN_CLASS, "u");

/**
 * `text` with every unseen character escaped as `\u{…}` (`\n`, `\t` by name).
 * `newlines` keeps line breaks and tabs as they are, for text shown as several
 * lines (an instruction). Idempotent: its output contains nothing to escape.
 */
export function visible(text: string, opts: { newlines?: boolean } = {}): string {
  return String(text).replace(UNSEEN, (ch) =>
    opts.newlines && (ch === "\n" || ch === "\t")
      ? ch
      : ch === "\n"
        ? "\\n"
        : ch === "\t"
          ? "\\t"
          : `\\u{${ch.codePointAt(0)!.toString(16).padStart(4, "0")}}`,
  );
}

/** True when `text` contains nothing `visible()` would escape (no control, bidi or invisible character). */
export function isPrintable(text: string): boolean {
  return !HAS_UNSEEN.test(text);
}
