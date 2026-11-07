/* Conversation expressions have a finite playback budget; history starts still. */
(function () {
  'use strict';
  const entries = new Map();
  let prefs = { display: 'static', frequency: 'restrained' };
  let revision = 0;
  let saving = false;
  const reduce = matchMedia('(prefers-reduced-motion: reduce)');
  const active = () =>
    !document.hidden && !reduce.matches && (!window.LisaMotion || window.LisaMotion.active());
  const observer = new IntersectionObserver((changes) =>
    changes.forEach((change) => {
      const entry = entries.get(change.target);
      if (entry) {
        entry.visible = change.isIntersecting;
        render(entry);
      }
    }),
  );
  function stop(entry) {
    if (entry.timer) {
      clearTimeout(entry.timer);
      entry.timer = null;
      entry.remaining = Math.max(0, entry.remaining - (performance.now() - entry.started));
    }
  }
  function showSource(entry, url, playing) {
    if (entry.url === url) return;
    entry.url = url;
    const image = entry.image;
    image.onload = () => {
      if (entry.url === url) {
        image.hidden = false;
        entry.fallback.hidden = true;
      }
    };
    image.onerror = () => {
      if (entry.url !== url) return;
      if (playing) entry.failedAnimation = true;
      else entry.failedPoster = true;
      render(entry);
    };
    image.src = url;
  }
  function render(entry) {
    stop(entry);
    const clip = window.LISA_MOTION_ART?.clips[entry.expression.assetId];
    const format = prefs.display === 'emoji' ? 'emoji' : entry.expression.format;
    entry.node.hidden = prefs.display === 'off';
    const sticker = !!clip && format !== 'emoji' && !entry.failedPoster && prefs.display !== 'off';
    const playing =
      sticker &&
      format === 'animated' &&
      prefs.display === 'auto' &&
      active() &&
      entry.visible &&
      entry.remaining > 0 &&
      !entry.failedAnimation;
    entry.node.dataset.playback = playing ? 'playing' : sticker ? 'static' : 'emoji';
    entry.replay.hidden =
      !sticker ||
      format !== 'animated' ||
      prefs.display !== 'auto' ||
      reduce.matches ||
      entry.failedAnimation;
    entry.replay.disabled = playing;
    if (!sticker) {
      entry.url = null;
      entry.image.removeAttribute('src');
      entry.image.hidden = true;
      entry.fallback.hidden = false;
      return;
    }
    showSource(entry, playing ? clip.src : clip.poster, playing);
    if (playing) {
      entry.started = performance.now();
      entry.timer = setTimeout(() => {
        entry.timer = null;
        entry.remaining = 0;
        render(entry);
      }, entry.remaining);
    }
  }
  function refreshEntries() {
    for (const [node, entry] of entries) {
      if (!node.isConnected) {
        stop(entry);
        observer.unobserve(node);
        entry.image.removeAttribute('src');
        entries.delete(node);
      } else render(entry);
    }
  }
  async function refresh() {
    if (saving) return;
    const version = ++revision;
    try {
      const r = await fetch('/api/expressions/preferences', { cache: 'no-store' });
      if (!r.ok) return;
      const next = await r.json();
      if (version !== revision || !['auto', 'static', 'emoji', 'off'].includes(next.display))
        return;
      prefs = next;
      refreshEntries();
    } catch (_) {
      /* Stills and readable fallback remain usable offline. */
    }
  }
  function create(expression, live) {
    const node = document.createElement('figure');
    node.className = 'expression-bubble';
    node.dataset.expressionId = expression.id;
    const image = document.createElement('img');
    image.width = image.height = 128;
    image.alt = expression.alt || 'Lisa';
    image.hidden = true;
    const fallback = document.createElement('span');
    fallback.className = 'expression-emoji';
    fallback.textContent = expression.emoji || '🙂';
    fallback.setAttribute('role', 'img');
    fallback.setAttribute('aria-label', image.alt);
    const caption = document.createElement('figcaption');
    caption.textContent = image.alt;
    // The image (or emoji fallback) already announces the label once.
    caption.setAttribute('aria-hidden', 'true');
    const replay = document.createElement('button');
    replay.type = 'button';
    replay.textContent = tr('expressions.replay');
    // Several stickers may be on screen: name which one replays.
    replay.setAttribute('aria-label', tr('expressions.replay') + ' · ' + image.alt);
    node.append(image, fallback, caption, replay);
    const duration = Math.min(5000, Math.max(500, Number(expression.durationMs) || 2500) * 2);
    const entry = {
      node,
      image,
      fallback,
      replay,
      expression,
      remaining: live ? duration : 0,
      visible: false,
      timer: null,
      started: 0,
      url: null,
      failedAnimation: false,
      failedPoster: false,
    };
    entries.set(node, entry);
    observer.observe(node);
    replay.onclick = () => {
      entry.remaining = duration;
      render(entry);
    };
    render(entry);
    return node;
  }
  async function mountSettings(target) {
    const box = document.createElement('section');
    box.className = 'v-card expression-settings';
    const title = document.createElement('h3');
    title.textContent = tr('expressions.title');
    box.append(title);
    const display = document.createElement('select');
    display.id = 'expressionDisplay';
    display.setAttribute('aria-label', title.textContent);
    ['auto', 'static', 'emoji', 'off'].forEach((v) =>
      display.add(new Option(tr('expressions.' + v), v)),
    );
    const frequency = document.createElement('select');
    frequency.id = 'expressionFrequency';
    frequency.setAttribute('aria-label', tr('expressions.frequency'));
    ['restrained', 'lively'].forEach((v) => frequency.add(new Option(tr('expressions.' + v), v)));
    const note = document.createElement('p');
    note.textContent = tr('expressions.note');
    const status = document.createElement('p');
    status.setAttribute('role', 'status');
    box.append(display, frequency, note, status);
    target.prepend(box);
    display.disabled = frequency.disabled = true;
    await refresh();
    display.value = prefs.display;
    frequency.value = prefs.frequency;
    display.disabled = frequency.disabled = false;
    const save = async () => {
      display.disabled = frequency.disabled = true;
      saving = true;
      ++revision;
      try {
        const r = await fetch('/api/expressions/preferences', {
          method: 'PUT',
          headers: { 'content-type': 'application/json' },
          body: JSON.stringify({ display: display.value, frequency: frequency.value }),
        });
        if (!r.ok) throw new Error('save');
        prefs = await r.json();
        refreshEntries();
        status.textContent = tr('expressions.saved');
      } catch (_) {
        display.value = prefs.display;
        frequency.value = prefs.frequency;
        status.textContent = tr('expressions.error');
      } finally {
        saving = false;
        ++revision;
        display.disabled = frequency.disabled = false;
      }
    };
    display.onchange = frequency.onchange = save;
  }
  window.LisaExpressions = Object.freeze({ create, refresh, mountSettings });
  window.addEventListener('lisa-motion-change', refreshEntries);
  window.addEventListener('focus', refresh);
  window.addEventListener('lisa-view-change', refreshEntries);
  document.addEventListener('visibilitychange', () => {
    refreshEntries();
    if (!document.hidden) void refresh();
  });
  reduce.addEventListener('change', refreshEntries);
  // Removing history/session DOM must release timers and decoded images immediately.
  new MutationObserver(() => {
    for (const [node, entry] of entries)
      if (!node.isConnected) {
        stop(entry);
        observer.unobserve(node);
        entry.image.removeAttribute('src');
        entries.delete(node);
      }
  }).observe(document.getElementById('log'), { childList: true });
  void refresh();
})();
