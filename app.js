// app.js — Live Lab orchestrator.
// Feature-detects capabilities once, sets a global status chip, then lazily
// initializes each demo when its card scrolls into view. Each demo owns its
// own fallback; this file only sequences them.

import { hasWebGPU, hasCanvas2D, once } from './js/common.js';
import { initDither } from './js/dither.js';
import { initFlowchart } from './js/flowchart.js';
import { initExtractor } from './js/extractor.js';
import { initRiskSim } from './js/risk-sim.js';

const LAB = '#lab';

function setGlobalStatus(text, kind) {
  const node = document.querySelector(`${LAB} [data-global-status]`);
  if (node) { node.textContent = text; node.dataset.kind = kind; }
}

async function boot() {
  const section = document.querySelector(LAB);
  if (!section) return; // page without the Lab (defensive)

  // ---- global capability detection ----
  const gpu = await hasWebGPU();
  const c2d = hasCanvas2D();
  let kind = 'off', text = 'Static fallback';
  if (gpu) { kind = 'ok'; text = 'WebGPU compute active'; }
  else if (c2d) { kind = 'warn'; text = 'CPU / Canvas2D mode'; }
  else { kind = 'off'; text = 'Static fallback (no canvas)'; }
  setGlobalStatus(text, kind);

  // ---- lazy init each demo via IntersectionObserver ----
  const demos = [
    { sel: '[data-demo=dither]', fn: () => initDither(section.querySelector('[data-demo=dither]')) },
    { sel: '[data-demo=flowchart]', fn: () => initFlowchart(section.querySelector('[data-demo=flowchart]')) },
    { sel: '[data-demo=extractor]', fn: () => initExtractor(section.querySelector('[data-demo=extractor]')) },
    { sel: '[data-demo=risk]', fn: () => initRiskSim(section.querySelector('[data-demo=risk]')) },
  ];

  // Reduced-motion / no-JS safety: each demo handles its own fallback, so we
  // still init them (extractor has no motion; others go static).
  const io = new IntersectionObserver((entries, obs) => {
    for (const e of entries) {
      if (!e.isIntersecting) continue;
      const match = demos.find(d => e.target.matches(d.sel));
      if (match) {
        once(e.target, () => {
          try { match.fn(); }
          catch (err) { console.error('[lab] init failed', match.sel, err); }
        });
        obs.unobserve(e.target);
      }
    }
  }, { rootMargin: '120px' });

  for (const d of demos) {
    const el = section.querySelector(d.sel);
    if (el) io.observe(el);
  }
}

if (document.readyState === 'loading') {
  document.addEventListener('DOMContentLoaded', boot);
} else {
  boot();
}
