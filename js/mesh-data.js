// mesh-data.js — verified SHADOW fleet topology, single source of truth.
// Data is verbatim from:
//   - ShadowArchive/01-registry/shadow-persona-registry.json (v3)
//   - reference/SHADOW-ARCHITECTURE-SPEC.md
//   - reference/SHADOW-CONTEXT.md (Tailscale IPs)
//   - reference/ARCHITECTURE.md (authority stack)
// Do not edit node identities here without re-verifying against the registry.

// 8 device/system nodes. `mesh: true` = persistent Tailscale full-mesh peer.
// x,y = VISUAL layout positions (0..1) chosen for clarity on a wide canvas;
// the topology (which connects to which) is in EDGES and is verbatim-true.
// Visual positions are a rendering choice, not a topology claim.
export const NODES = [
  { id: 'jarvis',  sys: 'J.A.R.V.I.S.', role: 'compute · operator',     hw: 'MacBook Air M4', mesh: true,  x: 0.50, y: 0.16, tier: 'device' },
  { id: 'friday',  sys: 'F.R.I.D.A.Y.', role: 'executor · hub · gateway', hw: 'Mac Mini M2',    mesh: true,  x: 0.50, y: 0.50, tier: 'device', hub: true },
  { id: 'aurion',  sys: 'A.U.R.I.O.N.', role: 'router · Linux compute',  hw: 'OptiPlex 9020',  mesh: true,  x: 0.18, y: 0.34, tier: 'device' },
  { id: 'ultron',  sys: 'U.L.T.R.O.N.', role: 'workstation · sandbox',   hw: 'ThinkPad X1',    mesh: true,  x: 0.82, y: 0.34, tier: 'device' },
  { id: 'sentry',  sys: 'S.E.N.T.R.Y.', role: 'control-plane · OCI',     hw: 'OCI Always Free',mesh: true,  x: 0.82, y: 0.70, tier: 'device' },
  { id: 'strata',  sys: 'S.T.R.A.T.A.', role: 'control-plane (co-loc)',  hw: 'co-loc AURION',  mesh: false, x: 0.18, y: 0.70, tier: 'device', satellite: true },
  { id: 'verona',  sys: 'V.E.R.O.N.A.', role: 'GPU burst · ephemeral',   hw: 'Colab Pro',      mesh: false, x: 0.88, y: 0.12, tier: 'device', satellite: true },
  { id: 'astemo',  sys: 'A.S.T.E.M.O.', role: 'async A2A · enterprise',  hw: 'Dropbox+GitHub', mesh: false, x: 0.50, y: 0.84, tier: 'device', satellite: true },
];

// Edges. The 5 persistent Tailscale nodes form a full mesh (10 edges);
// satellites attach via the documented transports (dashed/faint).
export const EDGES = [
  // Tailscale full-mesh core (JARVIS, FRIDAY, AURION, ULTRON, SENTRY)
  ['jarvis', 'friday'], ['jarvis', 'aurion'], ['jarvis', 'ultron'], ['jarvis', 'sentry'],
  ['friday', 'aurion'], ['friday', 'ultron'], ['friday', 'sentry'],
  ['aurion', 'ultron'], ['aurion', 'sentry'],
  ['ultron', 'sentry'],
  // Off-mesh satellites (different transports — fainter in the field)
  ['strata', 'aurion'],   // co-located control-plane
  ['verona', 'jarvis'],   // on-demand GPU burst
  ['astemo', 'friday'],   // async A2A via Dropbox/GitHub
];

// Personas layered on host devices. Leo host: architecture docs (SPEC §3 +
// ARCHITECTURE authority stack + CONTEXT) attestate FRIDAY leo-profile with a
// documented Unix-socket link; registry v3 lists sd-ultron. Rendered on
// FRIDAY per the more-detailed source. (Conflict noted here, not in UI.)
export const PERSONAS = [
  { id: 'red',    zone: 'enterprise',          host: 'friday', tone: 'formal engineering' },
  { id: 'mac',    zone: 'developer',           host: 'friday', tone: 'terse technical' },
  { id: 'leo',    zone: 'personal',            host: 'friday', tone: 'grounded conversational' },
  { id: 'shadow', zone: 'developer',           host: 'jarvis', tone: 'systems research' },
];

// Word-length → tier mapping (S.H.A.D.O.W. naming architecture).
export const TIERS = { 6: 'device system', 5: 'service/daemon', 4: 'subsystem/bridge', 3: 'workspace persona' };

export const TAILNET = 'tail79a107.ts.net';
