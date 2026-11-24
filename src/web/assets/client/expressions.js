/* Conversation expressions have a finite playback budget; history starts still. */
(function () {
  'use strict';
  const entries = new Map();
  let prefs = { display: 'static', frequency: 'restrained' };
  let revision = 0;
  let saving = false;
  const reduce = matchMedia('(prefers-reduced-motion: reduce)');
  const localizedLabel = (text) => {
    const parts = String(text || 'Lisa').split(' · ');
    return LISA_LOCALE === 'zh-CN' ? parts[1] || parts[0] : parts[0];
  };
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
  function create(expression, live, role = 'assistant') {
    const node = document.createElement('figure');
    node.className = 'expression-bubble';
    node.dataset.expressionId = expression.id;
    node.dataset.role = role;
    const image = document.createElement('img');
    image.width = image.height = 128;
    image.alt = localizedLabel(expression.alt);
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
    const label = document.createElement('div');
    label.className = 'view-sec-label';
    label.textContent = tr('expressions.title');
    target.prepend(label);
    const box = document.createElement('section');
    box.className = 'set-card expression-settings';
    const display = document.createElement('select');
    display.id = 'expressionDisplay';
    display.setAttribute('aria-label', tr('expressions.title'));
    ['auto', 'static', 'emoji', 'off'].forEach((v) =>
      display.add(new Option(tr('expressions.' + v), v)),
    );
    const frequency = document.createElement('select');
    frequency.id = 'expressionFrequency';
    frequency.setAttribute('aria-label', tr('expressions.frequency'));
    ['restrained', 'lively'].forEach((v) => frequency.add(new Option(tr('expressions.' + v), v)));
    display.classList.add('set-input', 'set-theme');
    frequency.classList.add('set-input', 'set-theme');
    const mkRow = (nameText, subText, ctrl) => {
      const r = document.createElement('div');
      r.className = 'set-row';
      const main = document.createElement('div');
      main.className = 'set-main';
      const n = document.createElement('div');
      n.className = 'set-name';
      n.textContent = nameText;
      main.appendChild(n);
      if (subText) {
        const s = document.createElement('div');
        s.className = 'set-sub';
        s.textContent = subText;
        main.appendChild(s);
      }
      r.append(main, ctrl);
      return r;
    };
    const status = document.createElement('p');
    status.setAttribute('role', 'status');
    box.append(
      mkRow('Display mode', tr('expressions.note'), display),
      mkRow('Frequency', '', frequency),
      status,
    );
    label.after(box);
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
  const drafts = new Map();
  const sessionKey = () => window.lisaActiveSessionId || 'current';
  const selected = () => drafts.get(sessionKey());
  function refreshDraft() {
    const target = document.getElementById('expressionDraft');
    if (!target) return;
    const value = selected();
    target.replaceChildren();
    target.hidden = !value;
    if (!value) return;
    const img = document.createElement('img');
    img.src = window.LISA_MOTION_ART.clips[value.assetId].poster;
    img.alt = localizedLabel(value.alt);
    const label = document.createElement('span');
    label.textContent = localizedLabel(value.alt);
    const remove = document.createElement('button');
    remove.type = 'button';
    remove.textContent = '×';
    remove.setAttribute('aria-label', tr('expressions.remove'));
    remove.onclick = () => { drafts.delete(sessionKey()); refreshDraft(); };
    target.append(img, label, remove);
  }
  function take() {
    const value = selected();
    drafts.delete(sessionKey());
    refreshDraft();
    return value;
  }
  function mountComposer() {
    const trigger = document.getElementById('expressionPickerBtn');
    if (!trigger) return;
    trigger.title = tr('expressions.picker');
    trigger.setAttribute('aria-label', trigger.title);
    const dialog = document.createElement('dialog');
    dialog.className = 'expression-picker';
    dialog.setAttribute('aria-labelledby', 'expressionPickerTitle');
    const header = document.createElement('header');
    const title = document.createElement('h2');
    title.id = 'expressionPickerTitle';
    title.textContent = tr('expressions.picker');
    const close = document.createElement('button');
    close.type = 'button'; close.textContent = '×';
    close.setAttribute('aria-label', tr('expressions.close'));
    close.onclick = () => dialog.close();
    header.append(title, close);
    const tabs = document.createElement('div');
    tabs.className = 'expression-tabs';
    tabs.setAttribute('aria-label', tr('expressions.category'));
    const grid = document.createElement('div');
    grid.className = 'expression-grid';
    const note = document.createElement('p');
    note.textContent = tr('expressions.chooseHint');
    function show(category) {
      grid.replaceChildren();
      for (const button of tabs.querySelectorAll('button')) button.setAttribute('aria-pressed', String(button.dataset.category === category));
      for (const item of window.LISA_EXPRESSION_CATALOG.filter((entry) => category === 'stickers' ? entry.id.startsWith('sticker-') : !entry.id.startsWith('sticker-'))) {
        const clip = window.LISA_MOTION_ART.clips[item.id];
        const button = document.createElement('button');
        button.type = 'button'; button.dataset.assetId = item.id;
        button.setAttribute('aria-label', localizedLabel(item.alt));
        const img = document.createElement('img');
        img.src = clip.poster; img.alt = ''; img.loading = 'lazy'; img.width = img.height = 88;
        const label = document.createElement('span'); label.textContent = localizedLabel(item.alt);
        button.append(img, label);
        button.onclick = () => {
          drafts.set(sessionKey(), { version: 1, id: crypto.randomUUID(), assetId: item.id, format: 'animated', alt: item.alt, emoji: item.emoji, durationMs: clip.durationMs });
          refreshDraft(); dialog.close(); document.getElementById('input').focus();
        };
        grid.append(button);
      }
    }
    for (const category of ['stickers', 'moods']) {
      const button = document.createElement('button'); button.type = 'button';
      button.dataset.category = category; button.textContent = tr('expressions.' + category);
      button.onclick = () => show(category); tabs.append(button);
    }
    dialog.append(header, tabs, grid, note);
    document.body.append(dialog);
    trigger.onclick = () => { show('stickers'); dialog.showModal(); };
    window.addEventListener('lisa-session-change', () => { dialog.close(); refreshDraft(); });
  }
  window.LisaExpressions = Object.freeze({ create, refresh, mountSettings, mountComposer, selected, take });
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
