/** Shared appearance for the Cloud sign-in and account pages. */
export const PAGE_APPEARANCE_CSS = `
  :root {
    color-scheme: dark;
    --page-bg: #0b1024; --page-card: #161c3c; --page-text: #e8eaff;
    --page-muted: #aeb5d3; --page-border: #303858; --page-inset: #0c1126;
    --page-accent: #6ad4ff; --page-on-accent: #0a1024;
    --page-success: #3ddc97; --page-error: #ff95a8;
  }
  :root[data-theme="calm"] {
    color-scheme: light;
    --page-bg: #f5f6fa; --page-card: #ffffff; --page-text: #1b2430;
    --page-muted: #5f6878; --page-border: #c8cfdd; --page-inset: #f0f3f8;
    --page-accent: #4f5bd5; --page-on-accent: #ffffff;
    --page-success: #147653; --page-error: #be2945;
  }
  body { padding: 32px 16px; -webkit-font-smoothing: antialiased; }
  .card { max-width: 100%; box-shadow: 0 16px 48px rgba(32,45,70,.1); }
  :focus-visible { outline: 2px solid var(--page-accent); outline-offset: 3px; }
  input:focus { box-shadow: 0 0 0 3px color-mix(in srgb, var(--page-accent) 16%, transparent); }
  button { min-height: 44px; font-family: inherit; }
  .row { gap: 16px; flex-wrap: wrap; }
  .row > :last-child { overflow-wrap: anywhere; min-width: 0; }
`;

// Runs in the head before the page is painted. Never writes a default over a
// user's existing shell preference, and remains usable with storage blocked.
export const PAGE_APPEARANCE_JS = `
  (() => {
    const system = matchMedia('(prefers-color-scheme: dark)');
    const read = () => { try { return localStorage.getItem('lisa-theme'); } catch (_) { return null; } };
    const apply = () => {
      const preference = read();
      const light = preference === 'calm' || (preference !== 'nebula' && !system.matches);
      document.documentElement.dataset.theme = light ? 'calm' : 'nebula';
    };
    apply();
    system.addEventListener('change', apply);
    window.addEventListener('storage', event => { if (!event.key || event.key === 'lisa-theme') apply(); });
  })();
`;
