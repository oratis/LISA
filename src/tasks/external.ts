/**
 * Fencing outside text for the Task Engine: the repo's external-content
 * markers (.codex/INVARIANTS.md, Context 5), as the task frame and the result
 * card use them.
 *
 * Text a task run produced after it read outside content (a page, a mail, a
 * watcher hit) is not Lisa's own words: wherever it is carried on — into the
 * next run's prompt, into the conversation as a card — it is fenced, and the
 * reader is tainted (#422 review N3).
 */

export type ExternalSource = "watcher" | "task-run";

export function externalOpen(source: ExternalSource): string {
  return `<<<EXTERNAL-CONTENT source="${source}">>>`;
}

export const EXTERNAL_CLOSE = "<<<END-EXTERNAL-CONTENT>>>";

/**
 * Characters that render as nothing (zero-width spaces and joiners, bidi
 * controls, variation selectors, …): they can split or visually reorder a
 * marker without changing how it looks.
 */
const INVISIBLE = /\p{Default_Ignorable_Code_Point}/gu;

/**
 * A character whose compatibility form (NFKC) is an angle bracket — fullwidth
 * ＜ ＞, small ﹤ ﹥ — folded to it. Only those: NFKC over the whole text would
 * also rewrite CJK fullwidth punctuation (，：) in the quoted text, and only
 * brackets matter for the markers.
 */
function foldBracket(ch: string): string {
  const folded = ch.normalize("NFKC");
  return /[<>]/.test(folded) ? folded : ch;
}

/**
 * Outside text, fenced so that a later reader takes it as data. It is
 * normalised first — invisible characters removed, look-alike brackets folded
 * — so a marker disguised that way becomes a plain one, and then every run of
 * two or more angle brackets is defused (‹ ›): the text can neither close the
 * fence nor open one of its own, nor show something that looks like either.
 */
export function fenceExternal(text: string, source: ExternalSource): string {
  const defused = text
    .replace(INVISIBLE, "")
    .replace(/[^\p{ASCII}]/gu, foldBracket)
    .replace(/<{2,}/g, (m) => "‹".repeat(m.length))
    .replace(/>{2,}/g, (m) => "›".repeat(m.length));
  return `${externalOpen(source)}\n${defused}\n${EXTERNAL_CLOSE}`;
}

/**
 * Did this run read outside content? Started by a watcher (its prompt quotes
 * a page, a feed or a mail, and a notify-mode hit's summary IS that text),
 * tainted by a call it made, or tainted from its first call because its prompt
 * or its folder carried what a tainted earlier run of the task left behind.
 */
export function runWasTainted(run: {
  trigger?: string;
  input?: string;
  tainted?: boolean;
  inheritedTaint?: boolean;
}): boolean {
  return (
    run.tainted === true ||
    run.inheritedTaint === true ||
    run.input !== undefined ||
    run.trigger === "watcher"
  );
}
