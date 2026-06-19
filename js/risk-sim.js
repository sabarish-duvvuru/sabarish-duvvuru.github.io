// risk-sim.js — fault propagation field simulation.
// A supplier → validation → release grid. Click/inject a fault at a node; a
// colored wave propagates to coupled downstream nodes per the coupling strength
// and isolation rules. Engineering framing: FMEA made tangible — see how a
// single failure cascades before it happens.
// Fallback: static annotated SVG diagram with a CSS keyframe wave.

import { hasCanvas2D, viewportLoop, prefersReducedMotion, pointer, clamp, setStatus } from './common.js';

// Domain-native layout: three columns = supplier, validation, release.
// Rows = parts/subsystems. Coupling flows left→right with some cross-links.
function buildGrid(cols, rows) {
  const nodes = [];
  for (let c = 0; c < cols; c++) {
    for (let r = 0; r < rows; r++) {
      nodes.push({
        id: `${c}-${r}`,
        col: c, row: r,
        // labels per column
        label: LABELS[c][r % LABELS[c].length],
        x: 0, y: 0, // set at draw time from canvas size
        fault: 0,   // 0..1 current fault intensity
        everFault: false,
      });
    }
  }
  // edges: each node → same row next col, plus a couple of cross-links
  const edges = [];
  for (let c = 0; c < cols - 1; c++) {
    for (let r = 0; r < rows; r++) {
      const a = nodes.find(n => n.col === c && n.row === r);
      const b = nodes.find(n => n.col === c + 1 && n.row === r);
      edges.push({ from: a, to: b, strength: 1 });
      // cross-link to neighbor row
      if (rows > 1) {
        const r2 = (r + 1) % rows;
        const a2 = nodes.find(n => n.col === c && n.row === r);
        const b2 = nodes.find(n => n.col === c + 1 && n.row === r2);
        edges.push({ from: a2, to: b2, strength: 0.5 });
      }
    }
  }
  return { nodes, edges };
}

const LABELS = [
  ['stator PPAP', 'magnet bond', 'housing tol', 'resolver'],
  ['thermal cycle', 'vibration', 'EI test', 'duty cycle'],
  ['drawing rel.', 'BOM freeze', 'ECN', 'deviation'],
];

export function initRiskSim(root) {
  const canvas = root.querySelector('[data-canvas]');
  const reduced = prefersReducedMotion();

  if (!hasCanvas2D() || reduced) {
    renderStaticSVG(root);
    setStatus(root, reduced ? 'Static (reduced motion)' : 'Static diagram', 'warn');
    return;
  }

  const COLS = 3, ROWS = 4;
  const { nodes, edges } = buildGrid(COLS, ROWS);

  const coupling = root.querySelector('[name=coupling]');
  const isolation = root.querySelector('[name=isolation]');
  const resetBtn = root.querySelector('[data-reset]');
  const state = {
    coupling: parseFloat(coupling.value), // 0..1 propagation probability
    isolation: parseFloat(isolation.value), // 0..1 fault-blocking
  };
  coupling.addEventListener('input', () => { state.coupling = parseFloat(coupling.value); });
  isolation.addEventListener('input', () => { state.isolation = parseFloat(isolation.value); });
  resetBtn.addEventListener('click', () => { for (const n of nodes) { n.fault = 0; n.everFault = false; } });

  const dpr = Math.min(window.devicePixelRatio || 1, 2);
  function resize() {
    const r = canvas.getBoundingClientRect();
    canvas.width = r.width * dpr;
    canvas.height = r.height * dpr;
    // position nodes
    const w = r.width, h = r.height;
    const padX = 60, padY = 36;
    for (const n of nodes) {
      n.x = padX + (n.col / (COLS - 1)) * (w - 2 * padX);
      n.y = padY + (n.row / (ROWS - 1)) * (h - 2 * padY);
    }
  }
  resize();
  window.addEventListener('resize', resize);

  const ctx = canvas.getContext('2d');
  ctx.scale(dpr, dpr);

  // inject fault on click
  canvas.addEventListener('pointerdown', (e) => {
    const p = pointer(canvas, e);
    let nearest = null, nd = Infinity;
    for (const n of nodes) {
      const d = Math.hypot(p.x - n.x, p.y - n.y);
      if (d < nd && d < 40) { nd = d; nearest = n; }
    }
    if (nearest) {
      nearest.fault = 1;
      nearest.everFault = true;
    }
  });

  // propagation step (called each frame, throttled)
  let stepAcc = 0;
  function propagate(dt) {
    stepAcc += dt;
    if (stepAcc < 0.25) return; // step every 0.25s
    stepAcc = 0;
    const next = nodes.map(n => n.fault);
    for (const e of edges) {
      if (e.from.fault > 0.4) {
        // propagate with probability = coupling * edgeStrength * (1 - isolation)
        const p = state.coupling * e.strength * (1 - state.isolation);
        if (Math.random() < p) {
          const idx = nodes.indexOf(e.to);
          next[idx] = Math.max(next[idx], e.from.fault * 0.85);
          nodes[idx].everFault = true;
        }
      }
    }
    // decay
    for (let i = 0; i < nodes.length; i++) {
      next[i] = Math.max(0, next[i] - 0.04);
      nodes[i].fault = next[i];
    }
  }

  function draw() {
    const r = canvas.getBoundingClientRect();
    ctx.clearRect(0, 0, r.width, r.height);

    // column headers
    ctx.fillStyle = '#626a76';
    ctx.font = '600 10px Inter, system-ui, sans-serif';
    ctx.textAlign = 'center';
    const colNames = ['Supplier', 'Validation', 'Release'];
    for (let c = 0; c < COLS; c++) {
      const x = 60 + (c / (COLS - 1)) * (r.width - 120);
      ctx.fillText(colNames[c].toUpperCase(), x, 18);
    }

    // edges
    ctx.lineWidth = 1.2;
    for (const e of edges) {
      const active = e.from.fault > 0.3 && e.to.fault > 0.3;
      ctx.strokeStyle = active ? 'rgba(138,90,0,0.55)' : (e.strength < 0.8 ? '#ece5d4' : '#d3cab6');
      ctx.beginPath();
      ctx.moveTo(e.from.x, e.from.y);
      ctx.lineTo(e.to.x, e.to.y);
      ctx.stroke();
    }

    // nodes
    for (const n of nodes) {
      const f = n.fault;
      // base
      ctx.beginPath();
      ctx.arc(n.x, n.y, 14, 0, Math.PI * 2);
      if (f > 0.05) {
        // gradient from calm navy to amber by fault
        const g = ctx.createRadialGradient(n.x, n.y, 2, n.x, n.y, 16);
        const a = clamp(f, 0, 1);
        // navy → amber blend
        const r1 = Math.round(30 + (200 - 30) * a);
        const g1 = Math.round(58 + (90 - 58) * a);
        const b1 = Math.round(95 + (0 - 95) * a);
        g.addColorStop(0, `rgba(${r1},${g1},${b1},1)`);
        g.addColorStop(1, `rgba(${r1},${g1},${b1},0.85)`);
        ctx.fillStyle = g;
      } else if (n.everFault) {
        ctx.fillStyle = '#f0e6d0'; // touched
      } else {
        ctx.fillStyle = '#1e3a5f';
      }
      ctx.fill();
      ctx.lineWidth = n.fault > 0.5 ? 2 : 1;
      ctx.strokeStyle = n.fault > 0.3 ? '#8a5a00' : (n.everFault ? '#e0c98a' : '#152d49');
      ctx.stroke();

      // fault ring when active
      if (f > 0.2) {
        ctx.beginPath();
        ctx.arc(n.x, n.y, 14 + f * 8, 0, Math.PI * 2);
        ctx.strokeStyle = `rgba(138,90,0,${f * 0.4})`;
        ctx.lineWidth = 1.5;
        ctx.stroke();
      }

      // label
      ctx.fillStyle = n.fault > 0.4 ? '#1b2027' : '#626a76';
      ctx.font = '500 9.5px Inter, system-ui, sans-serif';
      ctx.textAlign = 'center';
      ctx.fillText(n.label, n.x, n.y + 28);
    }
  }

  setStatus(root, 'Click any node to inject a fault', 'ok');
  const loop = viewportLoop(canvas, (dt) => { propagate(dt); draw(); });
  loop.start();
}

function renderStaticSVG(root) {
  const host = root.querySelector('[data-canvas]');
  const svg = document.createElement('div');
  svg.className = 'risk-static';
  svg.innerHTML = `
  <svg viewBox="0 0 600 260" width="100%" height="auto" role="img" aria-label="Risk propagation diagram across supplier, validation, and release">
    <text x="100" y="20" text-anchor="middle" fill="#626a76" font-size="10" font-weight="600" font-family="Inter,system-ui,sans-serif">SUPPLIER</text>
    <text x="300" y="20" text-anchor="middle" fill="#626a76" font-size="10" font-weight="600" font-family="Inter,system-ui,sans-serif">VALIDATION</text>
    <text x="500" y="20" text-anchor="middle" fill="#626a76" font-size="10" font-weight="600" font-family="Inter,system-ui,sans-serif">RELEASE</text>
    ${[60, 110, 160, 210].map((y, i) => `
      <line x1="100" y1="${y}" x2="300" y2="${y}" stroke="#d3cab6" stroke-width="1.2"/>
      <line x1="300" y1="${y}" x2="500" y2="${y}" stroke="#d3cab6" stroke-width="1.2"/>
      <circle cx="100" cy="${y}" r="14" fill="#1e3a5f"/>
      <circle cx="300" cy="${y}" r="14" fill="#1e3a5f"/>
      <circle cx="500" cy="${y}" r="14" fill="#1e3a5f"/>
      <text x="100" y="${y + 28}" text-anchor="middle" fill="#626a76" font-size="9" font-family="Inter,system-ui,sans-serif">${LABELS[0][i]}</text>
      <text x="300" y="${y + 28}" text-anchor="middle" fill="#626a76" font-size="9" font-family="Inter,system-ui,sans-serif">${LABELS[1][i]}</text>
      <text x="500" y="${y + 28}" text-anchor="middle" fill="#626a76" font-size="9" font-family="Inter,system-ui,sans-serif">${LABELS[2][i]}</text>
    `).join('')}
    <circle cx="100" cy="110" r="14" fill="#8a5a00">
      <animate attributeName="r" values="14;22;14" dur="2s" repeatCount="indefinite"/>
      <animate attributeName="opacity" values="1;0.4;1" dur="2s" repeatCount="indefinite"/>
    </circle>
    <text x="300" y="248" text-anchor="middle" fill="#878d97" font-size="9" font-style="italic" font-family="Inter,system-ui,sans-serif">Static preview — enable motion + WebGPU/Canvas for the live cascade.</text>
  </svg>`;
  if (host.tagName === 'CANVAS') host.replaceWith(svg); else host.innerHTML = svg.innerHTML;
}
