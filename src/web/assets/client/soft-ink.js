/* Shared atlas renderer. No per-mood network requests and no change to mood semantics. */
(function () {
  'use strict';
  const manifest = window.LISA_ART;
  const sources = new Map();
  const frames = new Map();
  const requests = new WeakMap();

  function source(src) {
    if (!sources.has(src)) {
      const pending = new Promise((resolve, reject) => {
        const image = new Image();
        image.onload = () => resolve(image);
        image.onerror = () => reject(new Error('Artwork unavailable'));
        image.src = src;
      });
      sources.set(src, pending);
      pending.catch(() => { if (sources.get(src) === pending) sources.delete(src); });
    }
    return sources.get(src);
  }

  function indexFor(slug) {
    const aliases = manifest.portraits.aliases;
    return Object.prototype.hasOwnProperty.call(aliases, slug) ? aliases[slug] : 0;
  }

  function frame(kind, index, size) {
    const spec = manifest[kind];
    if (!spec || !Number.isInteger(index) || index < 0 || index >= spec.columns * spec.rows) {
      return Promise.reject(new Error('Unknown artwork frame'));
    }
    size = size || 256;
    const key = kind + ':' + index + ':' + size;
    if (!frames.has(key)) {
      const src = kind === 'portraits' && size <= 128 && spec.smallSrc ? spec.smallSrc : spec.src;
      const pending = source(src).then(image => {
        const canvas = document.createElement('canvas');
        canvas.width = size;
        canvas.height = size;
        const context = canvas.getContext('2d');
        if (!context) throw new Error('Canvas unavailable');
        context.imageSmoothingEnabled = true;
        context.imageSmoothingQuality = 'high';
        const width = image.naturalWidth / spec.columns;
        const height = image.naturalHeight / spec.rows;
        context.drawImage(image, (index % spec.columns) * width, Math.floor(index / spec.columns) * height,
          width, height, 0, 0, size, size);
        return canvas.toDataURL('image/png');
      });
      frames.set(key, pending);
      pending.catch(() => { if (frames.get(key) === pending) frames.delete(key); });
    }
    return frames.get(key);
  }

  function paint(element, kind, index, size) {
    const ticket = {};
    requests.set(element, ticket);
    return frame(kind, index, size).then(url => {
      // A slow earlier load must never overwrite a newer mood.
      if (requests.get(element) !== ticket) return false;
      element.src = url;
      return true;
    }).catch(() => false); // Preserve the last successful image / bundled fallback.
  }

  window.LisaArt = Object.freeze({
    indexFor,
    frame,
    paint,
    portrait: (element, slug, size) => paint(element, 'portraits', indexFor(slug), size || 128),
  });
})();
