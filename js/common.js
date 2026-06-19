// common.js — shared foundation for the Live Lab demos.
// Feature detection, reduced-motion, IntersectionObserver gating, rAF helpers.
// Zero dependencies. Pure ES module. Safe to import from any demo.

export const prefersReducedMotion = () =>
  typeof matchMedia !== 'undefined' &&
  matchMedia('(prefers-reduced-motion: reduce)').matches;

// WebGPU availability check. Resolves false for any failure — callers must
// always have a non-WebGPU path.
export async function hasWebGPU() {
  if (typeof navigator === 'undefined' || !('gpu' in navigator)) return false;
  try {
    const adapter = await navigator.gpu.requestAdapter();
    return !!adapter;
  } catch {
    return false;
  }
}

export function hasCanvas2D() {
  if (typeof document === 'undefined') return false;
  try {
    return !!document.createElement('canvas').getContext('2d');
  } catch {
    return false;
  }
}

// IntersectionObserver-gated animation loop. Runs `frame(dt)` only while the
// element is in the viewport; pauses automatically when scrolled away.
// Returns a controller with start()/stop()/running().
export function viewportLoop(el, frame, { threshold = 0.05 } = {}) {
  let rafId = null;
  let last = 0;
  let running = false;
  let visible = false;

  const step = (t) => {
    if (!running || !visible) return;
    const dt = last ? (t - last) / 1000 : 0;
    last = t;
    try { frame(dt, t); } catch (e) { console.error('[lab] frame error', e); stop(); }
    if (running) rafId = requestAnimationFrame(step);
  };

  const io = new IntersectionObserver((entries) => {
    visible = entries[0].isIntersecting;
    if (visible && running && rafId === null) {
      last = 0;
      rafId = requestAnimationFrame(step);
    } else if (!visible && rafId !== null) {
      cancelAnimationFrame(rafId);
      rafId = null;
    }
  }, { threshold });
  io.observe(el);

  function start() {
    if (running) return;
    running = true;
    if (visible && rafId === null) {
      last = 0;
      rafId = requestAnimationFrame(step);
    }
  }
  function stop() {
    running = false;
    if (rafId !== null) { cancelAnimationFrame(rafId); rafId = null; }
  }
  function running_() { return running; }
  return { start, stop, running: running_, io };
}

// Debounce for text-input driven recompute (extractor, sliders).
export function debounce(fn, ms = 120) {
  let t = null;
  return (...args) => {
    clearTimeout(t);
    t = setTimeout(() => fn(...args), ms);
  };
}

// Clamp helper.
export const clamp = (v, lo, hi) => Math.min(hi, Math.max(lo, v));

// Pointer normalization across mouse + touch. Returns {x,y} in CSS pixels
// relative to the element.
export function pointer(el, evt) {
  const r = el.getBoundingClientRect();
  const p = evt.touches ? evt.touches[0] : evt;
  return { x: p.clientX - r.left, y: p.clientY - r.top };
}

// Lightweight status chip updater. Writes a one-line status into [data-status].
export function setStatus(host, text, kind = 'ok') {
  const node = host.querySelector('[data-status]');
  if (!node) return;
  node.textContent = text;
  node.dataset.kind = kind; // ok | warn | off
}

// Run an init only once per element (idempotent), guarding against
// double-initialization from re-renders.
const _inited = new WeakSet();
export function once(el, fn) {
  if (_inited.has(el)) return false;
  _inited.add(el);
  fn();
  return true;
}
