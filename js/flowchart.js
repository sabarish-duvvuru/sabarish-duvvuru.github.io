// flowchart.js — interactive force-directed readiness workflow graph.
// Nodes: inputs → AI draft → engineer gate → readiness output.
// Physics: spring (edge) + repulsion (node) + drag. Data particles flow along
// edges to make the "follow-up → readiness" story visible.
// Fallback: static SVG layout with CSS-animated flow dots.

import { hasCanvas2D, viewportLoop, prefersReducedMotion, pointer, clamp, setStatus } from './common.js';

// Public-safe example artifact shown on node hover.
const NODES = [
  { id: 'inputs',  label: 'Inputs',       sub: 'notes · emails · trackers · PDFs',       x: 0.12, y: 0.55, kind: 'source' },
  { id: 'ai',      label: 'AI draft',     sub: 'owners · actions · risks extracted',      x: 0.40, y: 0.30, kind: 'process' },
  { id: 'gate',    label: 'Engineer gate',sub: 'accept · correct · reject',               x: 0.66, y: 0.62, kind: 'decision' },
  { id: 'ready',   label: 'Readiness',    sub: 'review-ready update',                     x: 0.88, y: 0.40, kind: 'output' },
  { id: 'rework',  label: 'Rework',       sub: 'loop back on rejected items',             x: 0.40, y: 0.82, kind: 'loop' },
];
const EDGES = [
  ['inputs', 'ai'], ['ai', 'gate'], ['gate', 'ready'],
  ['gate', 'rework'], ['rework', 'ai'],
];

function layout(nodes, w, h) {
  // seed from normalized coords
  for (const n of nodes) { n.px = n.x * w; n.py = n.y * h; n.vx = 0; n.vy = 0; }
}

function stepPhysics(nodes, edges, w, h) {
  // repulsion
  for (let i = 0; i < nodes.length; i++) {
    for (let j = i + 1; j < nodes.length; j++) {
      const a = nodes[i], b = nodes[j];
      let dx = a.px - b.px, dy = a.py - b.py;
      let d2 = dx * dx + dy * dy;
      if (d2 < 1) { d2 = 1; dx = 1; }
      const f = 9000 / d2;
      const d = Math.sqrt(d2);
      const fx = (dx / d) * f, fy = (dy / d) * f;
      a.vx += fx; a.vy += fy; b.vx -= fx; b.vy -= fy;
    }
  }
  // springs
  const ideal = Math.min(w, h) * 0.32;
  for (const [s, t] of edges) {
    const a = nodes.find(n => n.id === s), b = nodes.find(n => n.id === t);
    const dx = b.px - a.px, dy = b.py - a.py;
    const d = Math.sqrt(dx * dx + dy * dy) || 1;
    const f = (d - ideal) * 0.04;
    const fx = (dx / d) * f, fy = (dy / d) * f;
    a.vx += fx; a.vy += fy; b.vx -= fx; b.vy -= fy;
  }
  // gentle pull to center
  for (const n of nodes) {
    n.vx += (w / 2 - n.px) * 0.002;
    n.vy += (h / 2 - n.py) * 0.002;
  }
  // integrate
  for (const n of nodes) {
    if (n.dragged) { n.vx = 0; n.vy = 0; continue; }
    n.vx *= 0.82; n.vy *= 0.82;
    n.px += n.vx; n.py += n.vy;
    const pad = 60;
    n.px = clamp(n.px, pad, w - pad);
    n.py = clamp(n.py, pad, h - pad);
  }
}

const KIND_STYLE = {
  source:   { fill: '#1e3a5f', text: '#fff',    ring: '#1e3a5f' },
  process:  { fill: '#fffdf7', text: '#1b2027', ring: '#c7d6e6' },
  decision: { fill: '#e9eff6', text: '#152d49', ring: '#1e3a5f' },
  output:   { fill: '#2f5d3f', text: '#fff',    ring: '#2f5d3f' },
  loop:     { fill: '#fffdf7', text: '#8a5a00', ring: '#e0c98a' },
};

export function initFlowchart(root) {
  const canvas = root.querySelector('[data-canvas]');
  const reduced = prefersReducedMotion();

  if (!hasCanvas2D() || reduced) {
    renderStaticSVG(root);
    setStatus(root, reduced ? 'Static (reduced motion)' : 'Static SVG', 'warn');
    return;
  }

  const dpr = Math.min(window.devicePixelRatio || 1, 2);
  function resize() {
    const r = canvas.getBoundingClientRect();
    canvas.width = r.width * dpr;
    canvas.height = r.height * dpr;
  }
  resize();
  window.addEventListener('resize', resize);

  const nodes = NODES.map(n => ({ ...n }));
  const edges = EDGES;
  let W = 0, H = 0;
  function syncSize() {
    W = canvas.width / dpr; H = canvas.height / dpr;
    if (!nodes[0].hasOwnProperty('px') || nodes.__laidOut !== canvas.width) {
      layout(nodes, W, H);
      nodes.__laidOut = canvas.width;
    }
  }
  syncSize();
  window.addEventListener('resize', syncSize);

  // particles flowing along edges
  const particles = edges.map(() => ({ t: Math.random(), speed: 0.18 + Math.random() * 0.12 }));

  const ctx = canvas.getContext('2d');
  ctx.scale(dpr, dpr);

  // interaction
  let drag = null;
  let hover = null;
  const findNode = (x, y) => {
    for (const n of nodes) {
      if (Math.hypot(x - n.px, y - n.py) < 34) return n;
    }
    return null;
  };
  canvas.addEventListener('pointerdown', (e) => {
    const p = pointer(canvas, e);
    const n = findNode(p.x, p.y);
    if (n) { n.dragged = true; drag = n; canvas.setPointerCapture(e.pointerId); }
  });
  canvas.addEventListener('pointermove', (e) => {
    const p = pointer(canvas, e);
    if (drag) { drag.px = p.x; drag.py = p.y; }
    hover = findNode(p.x, p.y);
    canvas.style.cursor = hover ? 'grab' : 'default';
  });
  const release = (e) => {
    if (drag) { drag.dragged = false; drag = null; }
    try { canvas.releasePointerCapture(e.pointerId); } catch {}
  };
  canvas.addEventListener('pointerup', release);
  canvas.addEventListener('pointercancel', release);
  canvas.addEventListener('pointerleave', () => { hover = null; });

  function draw() {
    stepPhysics(nodes, edges, W, H);
    ctx.clearRect(0, 0, W, H);

    // edges
    ctx.lineWidth = 1.5;
    for (let i = 0; i < edges.length; i++) {
      const [s, t] = edges[i];
      const a = nodes.find(n => n.id === s), b = nodes.find(n => n.id === t);
      const isLoop = s === 'rework';
      ctx.strokeStyle = isLoop ? '#e0c98a' : '#c7d6e6';
      ctx.beginPath();
      ctx.moveTo(a.px, a.py);
      // slight curve for readability
      const mx = (a.px + b.px) / 2, my = (a.py + b.py) / 2;
      const nx = -(b.py - a.py), ny = (b.px - a.px);
      const nl = Math.hypot(nx, ny) || 1;
      const curve = isLoop ? 60 : 18;
      ctx.quadraticCurveTo(mx + (nx / nl) * curve, my + (ny / nl) * curve, b.px, b.py);
      ctx.stroke();

      // particle
      const p = particles[i];
      p.t += p.speed * 0.016;
      if (p.t > 1) p.t -= 1;
      const tt = p.t;
      const px = (1 - tt) * (1 - tt) * a.px + 2 * (1 - tt) * tt * (mx + (nx / nl) * curve) + tt * tt * b.px;
      const py = (1 - tt) * (1 - tt) * a.py + 2 * (1 - tt) * tt * (my + (ny / nl) * curve) + tt * tt * b.py;
      ctx.fillStyle = isLoop ? '#8a5a00' : '#1e3a5f';
      ctx.beginPath();
      ctx.arc(px, py, 3, 0, Math.PI * 2);
      ctx.fill();
    }

    // nodes
    for (const n of nodes) {
      const st = KIND_STYLE[n.kind];
      const isHover = n === hover;
      ctx.beginPath();
      ctx.arc(n.px, n.py, isHover ? 30 : 26, 0, Math.PI * 2);
      ctx.fillStyle = st.fill;
      ctx.fill();
      ctx.lineWidth = isHover ? 2.5 : 1.5;
      ctx.strokeStyle = st.ring;
      ctx.stroke();

      ctx.fillStyle = st.text;
      ctx.font = '600 12px Inter, system-ui, sans-serif';
      ctx.textAlign = 'center';
      ctx.textBaseline = 'middle';
      ctx.fillText(n.label, n.px, n.py);
    }

    // hover tooltip
    if (hover) {
      const st = KIND_STYLE[hover.kind];
      const text = hover.sub;
      ctx.font = '500 11px Inter, system-ui, sans-serif';
      const tw = ctx.measureText(text).width + 20;
      const tx = clamp(hover.px - tw / 2, 8, W - tw - 8);
      const ty = hover.py + 40;
      ctx.fillStyle = 'rgba(27,32,39,0.94)';
      ctx.beginPath();
      ctx.roundRect(tx, ty, tw, 26, 6);
      ctx.fill();
      ctx.fillStyle = '#fffdf7';
      ctx.textAlign = 'left';
      ctx.textBaseline = 'middle';
      ctx.fillText(text, tx + 10, ty + 13);
    }
  }

  setStatus(root, 'Live · drag any node', 'ok');
  const loop = viewportLoop(canvas, draw);
  loop.start();
}

// ---- Static SVG fallback (no canvas, or reduced motion) ----
function renderStaticSVG(root) {
  const host = root.querySelector('[data-canvas]');
  // hide canvas, show SVG
  if (host.tagName === 'CANVAS') {
    const svg = document.createElement('div');
    svg.className = 'flow-static';
    svg.innerHTML = staticSVG();
    host.replaceWith(svg);
  } else {
    host.innerHTML = staticSVG();
  }
}

function staticSVG() {
  // simple left→right layout, CSS-animated flow dots via <animateMotion>
  const coords = {
    inputs: [80, 120], ai: [300, 70], gate: [520, 150],
    ready: [740, 90], rework: [300, 200],
  };
  const edgePath = (a, b, curve = 15) => {
    const [ax, ay] = coords[a], [bx, by] = coords[b];
    const mx = (ax + bx) / 2 + (a === 'rework' ? 40 : 0);
    const my = (ay + by) / 2 + 30;
    return `M${ax},${ay} Q${mx},${my} ${bx},${by}`;
  };
  let edges = '';
  for (const [s, t] of EDGES) {
    const isLoop = s === 'rework';
    edges += `<path d="${edgePath(s, t)}" stroke="${isLoop ? '#e0c98a' : '#c7d6e6'}" stroke-width="1.5" fill="none">
      <circle r="3" fill="${isLoop ? '#8a5a00' : '#1e3a5f'}"><animateMotion dur="${isLoop ? 3.5 : 2.8}s" repeatCount="indefinite"><mpath href="#p-${s}-${t}"/></animateMotion></circle>
    </path>
    <path id="p-${s}-${t}" d="${edgePath(s, t)}" fill="none" stroke="none"/>`;
  }
  let nodes = '';
  for (const n of NODES) {
    const st = KIND_STYLE[n.kind];
    const [x, y] = coords[n.id];
    nodes += `<g><circle cx="${x}" cy="${y}" r="26" fill="${st.fill}" stroke="${st.ring}" stroke-width="1.5"/>
      <text x="${x}" y="${y}" text-anchor="middle" dominant-baseline="middle" fill="${st.text}" font-size="11" font-weight="600" font-family="Inter,system-ui,sans-serif">${n.label}</text></g>`;
  }
  return `<svg viewBox="0 0 820 250" width="100%" height="auto" role="img" aria-label="Readiness workflow diagram">${edges}${nodes}</svg>`;
}
