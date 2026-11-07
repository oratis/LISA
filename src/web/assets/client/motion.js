/* One lifecycle for portraits, Island and Room. Removing the animated URL stops decoding. */
(function () {
  'use strict';
  if (!document.addEventListener) return;
  const manifest = window.LISA_MOTION_ART;
  const bindings = new Map();
  const media = window.matchMedia('(prefers-reduced-motion: reduce)');
  let hostVisible = window.parent === window;
  let pageVisible = true;
  const active = () => hostVisible && pageVisible && !document.hidden && !media.matches;
  const observer = 'IntersectionObserver' in window ? new IntersectionObserver(entries => {
    for (const entry of entries) {
      const binding = bindings.get(entry.target);
      if (binding) { binding.visible = entry.isIntersecting; render(binding); }
    }
  }) : null;

  function display(binding, url, state) {
    const element = binding.element;
    if (binding.url === url && element.dataset.motionState === state) return;
    binding.url = url;
    element.dataset.motionState = state;
    element.onload = () => {
      if (bindings.get(element) !== binding || binding.url !== url) return;
      element.style.visibility = 'visible';
      if (!binding.fallback) element.parentElement.classList.add('motion-ready');
    };
    element.onerror = () => {
      if (bindings.get(element) !== binding || binding.url !== url) return;
      if (state === 'playing') binding.failed = true;
      else binding.posterFailed = true;
      render(binding);
    };
    if (url) element.src = url;
    else {
      element.removeAttribute('src');
      element.style.visibility = 'hidden';
      element.parentElement.classList.remove('motion-ready');
    }
  }
  function render(binding) {
    const clip = manifest.clips[binding.id];
    const play = clip && active() && binding.visible && !binding.failed;
    if (play) display(binding, clip.src, 'playing');
    else if (clip && !binding.posterFailed) display(binding, clip.poster, 'static');
    else display(binding, binding.fallback, 'fallback');
  }
  function bind(element, id, fallback) {
    let binding = bindings.get(element);
    if (binding && binding.id === id && binding.fallback === fallback) return;
    binding = { element, id, fallback, visible: binding ? binding.visible : !observer, failed: false, posterFailed: false, url: undefined };
    bindings.set(element, binding);
    if (observer) observer.observe(element);
    element.dataset.motionClip = id || '';
    render(binding);
  }
  function refresh() {
    for (const [element, binding] of bindings) {
      if (!element.isConnected) {
        if (observer) observer.unobserve(element);
        bindings.delete(element);
        element.onload = element.onerror = null;
        element.removeAttribute('src');
      } else render(binding);
    }
    document.documentElement.dataset.motion = active() ? 'playing' : 'paused';
    window.dispatchEvent(new CustomEvent('lisa-motion-change', { detail: { active: active(), reduced: media.matches } }));
  }
  function setHostVisible(value) { hostVisible = !!value; refresh(); }
  document.addEventListener('visibilitychange', refresh);
  media.addEventListener('change', refresh);
  window.addEventListener('pagehide', () => { pageVisible = false; refresh(); });
  window.addEventListener('pageshow', () => { pageVisible = true; refresh(); });
  window.addEventListener('message', event => {
    if (event.source === window.parent && event.origin === location.origin && event.data && event.data.type === 'lisa-room-visibility') setHostVisible(event.data.visible);
  });
  window.LisaMotion = Object.freeze({ bind, active, setHostVisible, portraits: manifest.portraits, poses: manifest.poses, stickers: manifest.stickers });
  refresh();
  if (window.parent !== window) window.parent.postMessage({ type: 'lisa-room-ready' }, location.origin);
})();
