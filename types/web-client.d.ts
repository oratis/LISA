/**
 * Ambient declarations for the browser client (src/web/assets/client/main.js),
 * used only by tsconfig.client.json. Nothing here is part of the server build:
 * the main tsconfig includes `src/**` only, so this directory is invisible to
 * it.
 *
 * The client is one classic <script> in the global scope — not a module — so
 * everything it defines is a global, and a few things it uses are injected by
 * lisa-html.ts immediately above it. Declaring those makes the checker's
 * "cannot find name" diagnostics meaningful: they now point at real typos
 * instead of at the file's own architecture.
 */

/** Source-injected by lisa-html.ts (MD_RENDER_JS) just before this script. */
declare function renderMarkdown(text: string): string;

/**
 * Assigned as `window.<name> = …` in one block and read bare in another. They
 * are read defensively (`typeof x === 'function'`) at every call site, which
 * is why they are declared possibly-undefined rather than as plain functions.
 */
declare const updateReflection: ((text: string) => void) | undefined;
declare const refreshClaudeSessions: (() => unknown) | undefined;

/**
 * The client hangs its cross-block API off `window` (window.lisaSetActiveSession,
 * window.lisaRenderChatEmpty, window.refreshMail, …) — roughly forty names that
 * exist to let the top-level script and the two IIFE blocks talk. Enumerating
 * them here would be a second source of truth that goes stale silently, so the
 * namespace is open.
 */
interface Window {
  [key: string]: any;
}

/**
 * DOM narrowing that plain .js cannot express.
 *
 * document.getElementById returns HTMLElement, so `el.value`, `el.disabled`
 * and `el.placeholder` are errors on every single form control the client
 * touches; e.target is an EventTarget, so `.closest()` is an error in every
 * delegated handler. Writing a cast at each of ~170 sites would mean a JSDoc
 * comment per line in a file that has no other type annotations.
 *
 * These index signatures drop exactly that class of diagnostic and keep
 * everything else — unknown identifiers, wrong arity, misuse of the client's
 * own objects, unreachable code. Unknown-identifier checking is the reason
 * this config exists: the client's real bug class is a renamed-but-not-updated
 * global, which TS2304 catches and no test would.
 */
interface Element {
  [key: string]: any;
}
interface EventTarget {
  [key: string]: any;
}
/**
 * Same reason: a listener registered on a NodeListOf<Element> gets the generic
 * (evt: Event) overload, so `ev.key` in a keydown handler and `ev.currentTarget`
 * used as an element are both errors even though the DOM guarantees them.
 */
interface Event {
  [key: string]: any;
}
/** node.contains(e.target): the DOM accepts it, the .d.ts signature does not. */
interface Node {
  contains(other: EventTarget | Node | null): boolean;
}
/** iOS Safari's standalone-PWA flag, used by the install hint. */
interface Navigator {
  standalone?: boolean;
}
