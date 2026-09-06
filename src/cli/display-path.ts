/**
 * Render a filesystem path the way a person reads it: `$HOME` collapsed to `~`.
 *
 * CLI messages used to print absolute paths in full — a missing-key error was
 * one 200-character line dominated by `/Users/<name>/.lisa/config.env`. The
 * abbreviation is display-only; anything that opens, writes or execs a path
 * keeps using the absolute form.
 */
import os from "node:os";

export function displayPath(p: string, home: string = os.homedir()): string {
  if (!p || !home) return p;
  // Tolerate a trailing separator on the home dir (`HOME=/Users/x/`) so the
  // prefix test below never produces `~//.lisa`.
  const root = home.replace(/[\\/]+$/, "");
  if (!root) return p;
  if (p === root) return "~";
  // Only a real child path collapses — `/Users/oratisfoo` must not become
  // `~foo`, so the character after the home prefix has to be a separator.
  if (p.startsWith(root)) {
    const next = p.charAt(root.length);
    if (next === "/" || next === "\\") return "~" + p.slice(root.length);
  }
  return p;
}
