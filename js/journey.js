// journey.js — AI journey spend chart.
// Hand-rolled SVG area+line chart that draws on scroll (stroke-dashoffset
// animation). Reduced-motion → static full render. Zero dependencies.
//
// DATA INTEGRITY: the SPEND array below is PLACEHOLDER pending operator
// verification. Every value ships with a [verify] marker. The operator said
// spend grew over time; this models a plausible growth curve from a single
// ChatGPT Plus ($20, late 2022) to the current multi-provider stack. Real
// figures must replace these before the chart is credible.

import { prefersReducedMotion, clamp } from './common.js';

// ┌──────────────────────────────────────────────────────────────────────┐
// │  PLACEHOLDER DATA — replace with real figures before relying on this │
// │  Every point marked [verify]. Source: operator to confirm.           │
// └──────────────────────────────────────────────────────────────────────┘
export const SPEND = [
  { date: '2022-11', label: 'ChatGPT launch · Plus $20',         total: 0,  verify: true }, // free at launch
  { date: '2023-02', label: 'ChatGPT Plus',                      total: 20, verify: true },
  { date: '2023-08', label: '+ GitHub Copilot',                  total: 40, verify: true },
  { date: '2024-03', label: '+ Cursor Pro',                      total: 60, verify: true },
  { date: '2024-09', label: '+ Gemini Pro',                      total: 80, verify: true },
  { date: '2025-04', label: '+ Z.AI / OpenRouter metered',       total: 90, verify: true }, // mostly metered
  { date: '2025-10', label: 'multi-model routing matured',       total: 95, verify: true },
  { date: '2026-05', label: 'current stack (canonical $60/mo)',  total: 60, verify: true },
];

export function initSpendChart(root) {
  const host = root.querySelector('[data-chart]');
  if (!host) return;
  const reduced = prefersReducedMotion();

  const W = 760, H = 240, padL = 44, padR = 24, padT = 24, padB = 44;
  const innerW = W - padL - padR, innerH = H - padT - padB;

  const data = SPEND;
  const maxVal = Math.max(...data.map(d => d.total), 100);
  const xStep = innerW / (data.length - 1);

  const px = (i) => padL + i * xStep;
  const py = (v) => padT + innerH - (v / maxVal) * innerH;

  // line path
  const linePts = data.map((d, i) => `${px(i)},${py(d.total)}`);
  const linePath = 'M' + linePts.join(' L');
  // area path (close to bottom)
  const areaPath = linePath + ` L${px(data.length - 1)},${padT + innerH} L${padL},${padT + innerH} Z`;

  // y-axis ticks (0, 25, 50, 75, 100)
  const ticks = [0, 25, 50, 75, 100].filter(v => v <= maxVal + 1);

  const svg = `
  <svg viewBox="0 0 ${W} ${H}" width="100%" preserveAspectRatio="xMidYMid meet" role="img"
       style="height:auto;display:block"
       aria-label="Monthly AI subscription spend over time, growing from $0 at ChatGPT launch to approximately $60-95 per month. Values pending verification.">
    <defs>
      <linearGradient id="spend-grad" x1="0" y1="0" x2="0" y2="1">
        <stop offset="0%" stop-color="#1e3a5f" stop-opacity="0.28"/>
        <stop offset="100%" stop-color="#1e3a5f" stop-opacity="0.02"/>
      </linearGradient>
    </defs>
    ${ticks.map(v => {
      const y = py(v);
      return `<line x1="${padL}" y1="${y}" x2="${W - padR}" y2="${y}" stroke="#e4ded0" stroke-width="1"/>
              <text x="${padL - 8}" y="${y + 3}" text-anchor="end" fill="#878d97" font-size="10" font-family="ui-monospace,monospace">$${v}</text>`;
    }).join('')}
    <path d="${areaPath}" fill="url(#spend-grad)"/>
    <path class="spend-line" d="${linePath}" fill="none" stroke="#1e3a5f" stroke-width="2.5" stroke-linecap="round" stroke-linejoin="round"/>
    ${data.map((d, i) => `
      <g class="spend-pt">
        <circle cx="${px(i)}" cy="${py(d.total)}" r="4" fill="#fffdf7" stroke="#1e3a5f" stroke-width="2"/>
        <text x="${px(i)}" y="${H - padB + 16}" text-anchor="middle" fill="#878d97" font-size="9" font-family="ui-monospace,monospace">${d.date}</text>
        ${d.verify ? `<text x="${px(i)}" y="${py(d.total) - 12}" text-anchor="middle" fill="#8a5a00" font-size="9" font-weight="600">[verify]</text>` : ''}
      </g>`).join('')}
  </svg>`;

  host.innerHTML = svg;

  const line = host.querySelector('.spend-line');
  if (!line || reduced) {
    // static: fully drawn
    if (line) line.style.strokeDasharray = 'none';
    return;
  }

  // animate the line drawing in when scrolled into view
  const len = line.getTotalLength();
  line.style.strokeDasharray = len;
  line.style.strokeDashoffset = len;

  const io = new IntersectionObserver((entries) => {
    for (const e of entries) {
      if (e.isIntersecting) {
        line.style.transition = 'stroke-dashoffset 1.6s ease-out';
        line.style.strokeDashoffset = '0';
        io.unobserve(e.target);
      }
    }
  }, { threshold: 0.3 });
  io.observe(host);
}
