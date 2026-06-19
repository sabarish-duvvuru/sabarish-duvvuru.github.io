// extractor.js — deterministic, explainable action/risk/owner/due extractor.
// No neural net. A hand-built tokenizer + pattern/scoring pipeline that
// classifies spans of pasted engineering text into four labeled categories.
//
// Why deterministic (not a model): auditable, instant, zero-download, no model
// drift — the kind of AI assist you'd actually trust in an engineering review.
// This is the honest framing for the demo.

import { debounce, setStatus } from './common.js';

// ---- Lexicon (engineering-review tuned) ----
const OWNER_CUE = /\b(?:owner|assigned to|responsible|lead|owner:|@)\s*[:\-]?\s*/i;
// Names: Capitalized word(s), possibly "First Last", optionally leading @
const NAME = /(?:@?[A-Z][a-z]+(?:\s+[A-Z][a-z]+)?)/;
// Action verbs (imperative/base form). Engineering-review flavored.
const ACTION_VERBS = [
  'update','close','submit','review','send','confirm','provide','complete',
  'validate','verify','check','test','issue','release','approve','follow up',
  'escalate','schedule','prepare','align','finalize','open','track','draft',
  'share','coordinate','define','assess','investigate','resolve','fix','build',
];
const ACTION_VERB_RE = new RegExp(`\\b(${ACTION_VERBS.join('|')})(?:s|ed|ing)?\\b`, 'i');

const RISK_CUES = [
  /\brisk\b/i, /\bblock/i, /\bblocker/i, /\bmay (?:slip|delay|miss|fail|impact)/i,
  /\b(?:could|might|may) (?:cause|impact|delay|miss|fail|slip)/i,
  /\bbehind schedule/i, /\bnot ready/i, /\boverdue/i, /\bconcern/i,
  /\bopen issue/i, /\bTBD\b/i, /\bunknown\b/i, /\bunclear\b/i,
  /\bdiscrepancy/i, /\bnon-?conform/i, /\bdeviation/i, /\bawaiting/i,
  /\bdepends on/i, /\bif .*(?:then|risk)/i, /\bwatch\b/i,
];

const DUE_RE = /\b(?:due|by|before|target|ETA|need(?:ed)? by|close out by)\s*[:\-]?\s+((?:Jan(?:uary)?|Feb(?:ruary)?|Mar(?:ch)?|Apr(?:il)?|May|Jun(?:e)?|Jul(?:y)?|Aug(?:ust)?|Sep(?:t)?(?:ember)?|Oct(?:ober)?|Nov(?:ember)?|Dec(?:ember)?)\s*\d{1,2}(?:st|nd|rd|th)?|\d{1,2}[\/\-]\d{1,2}(?:[\/\-]\d{2,4})?|end of (?:week|month|q[1-4])|EOW|EOM|this week|next week|tomorrow|ASAP)/i;
const DATE_TOKEN = /\b(?:(?:Jan|Feb|Mar|Apr|May|Jun|Jul|Aug|Sep|Oct|Nov|Dec)[a-z]*\s*\d{1,2}(?:st|nd|rd|th)?|\d{1,2}[\/\-]\d{1,2}(?:[\/\-]\d{2,4})?|end of (?:week|month|q[1-4])|EOW|EOM|this week|next week|tomorrow|ASAP)\b/i;

// Split text into sentences (rough) then words with offsets.
function tokenize(text) {
  // sentence-ish split on . ! ? or newline, preserving offsets
  const sentences = [];
  const sRe = /[^.!?\n]+[.!?]?(?:\n|$)|[^.!?\n]+/g;
  let m;
  while ((m = sRe.exec(text))) {
    const s = m[0];
    if (s.trim()) sentences.push({ text: s, start: m.index });
  }
  return sentences;
}

// Extract structured items from one sentence.
function analyzeSentence(sent) {
  const t = sent.text;
  const items = []; // {type, text, start (abs), end (abs)}

  // OWNER: "Owner: Name" / "@Name" / "Name to <verb>"
  // Exclude common false-name words (sentence-starting capitalized words).
  const NON_NAMES = new Set(['Need','Needs','Please','Open','The','This','That','These','Those','We','They','It','If','When','After','Before','All','Any','Some','Each','Both','Neither','Every','No','Yes','Owner','Action','Risk','Due','Note','Notes','Todo','Follow','Update','As','So','But','And','Or','For','To','In','On','At','By','With','From']);
  const isName = (w) => w && !NON_NAMES.has(w) && /^[A-Z][a-z]+$/.test(w);
  let m = t.match(OWNER_CUE);
  let ownerName = null;
  if (m) {
    const after = t.slice(m.index + m[0].length);
    const nm = after.match(new RegExp('^' + NAME.source));
    if (nm) ownerName = nm[0];
  } else {
    // "Name to <verb>" pattern, e.g. "Sabarish to close DVP&R item"
    const nm = t.match(new RegExp(`^\\s*(${NAME.source})\\s+to\\s+${ACTION_VERB_RE.source}`));
    if (nm && isName(nm[1].replace('@',''))) ownerName = nm[1];
    // "@Name" mention
    const at = t.match(/@([A-Z][a-z]+(?:\s[A-Z][a-z]+)?)/);
    if (!ownerName && at) ownerName = at[1];
  }
  if (ownerName) {
    // find absolute offset
    const idx = t.indexOf(ownerName);
    if (idx >= 0) items.push({ type: 'owner', text: ownerName, start: sent.start + idx, end: sent.start + idx + ownerName.length });
  }

  // ACTION: leading imperative verb, or "<name> to <verb>", or verb after owner/dash
  let verbMatch = null;
  // leading verb at sentence start
  const leadVerb = t.match(new RegExp('^\\s*(' + ACTION_VERBS.join('|') + ')(?:s|ed|ing)?\\b', 'i'));
  if (leadVerb) verbMatch = leadVerb;
  // "Name to <verb>"
  const nameVerb = t.match(new RegExp(NAME.source + '\\s+to\\s+(' + ACTION_VERBS.join('|') + ')(?:s|ed|ing)?', 'i'));
  if (nameVerb) verbMatch = nameVerb;
  // generic "need to / please <verb>"
  const needVerb = t.match(new RegExp('\\b(?:need to|please|to|will|must)\\s+(' + ACTION_VERBS.join('|') + ')(?:s|ed|ing)?', 'i'));
  if (!verbMatch && needVerb) verbMatch = needVerb;
  // verb after an owner mention + dash/colon/em-dash: "Owner: Sabarish — close ..."
  if (!verbMatch) {
    const dashVerb = t.match(new RegExp('(?:' + NAME.source + ')\\s*[—\\-:.]\\s*(' + ACTION_VERBS.join('|') + ')(?:s|ed|ing)?', 'i'));
    if (dashVerb) verbMatch = dashVerb;
  }

  if (verbMatch) {
    // capture the verb + a short noun phrase after it (up to ~8 words or a date/owner)
    const vStart = verbMatch.index + (verbMatch[0].length - verbMatch[1].length);
    const vEnd = vStart + verbMatch[1].length;
    // extend to a phrase: grab up to 8 words following, stop at a due cue, owner cue, or sentence end
    const DUE_STOP = /\b(?:due|by|before|target|ETA|need(?:ed)? by|close out by|so that|because|;|,)\b/i;
    let phraseEnd = vEnd;
    const rest = t.slice(vEnd);
    let stop = rest.search(DUE_STOP);
    if (stop === -1) stop = rest.search(new RegExp('(?:' + OWNER_CUE.source + '|$)', 'i'));
    if (stop === -1) stop = rest.length;
    const words = rest.slice(0, stop).split(/\s+/).filter(Boolean);
    const take = words.slice(0, 8).join(' ');
    if (take.trim()) phraseEnd = vEnd + rest.indexOf(take) + take.length;
    const phraseText = t.slice(vStart, Math.max(vEnd, phraseEnd)).trim();
    if (phraseText.length > 2) {
      items.push({ type: 'action', text: phraseText, start: sent.start + vStart, end: sent.start + vStart + phraseText.length });
    }
  }

  // RISK: cue phrase anywhere in sentence — capture the clause containing the cue
  for (const re of RISK_CUES) {
    const rm = t.match(re);
    if (rm) {
      const cStart = rm.index;
      const cEnd = cStart + rm[0].length;
      // expand left to clause boundary (start of sentence, or a semicolon/comma/conjunction)
      const left = t.slice(0, cStart);
      const leftStop = Math.max(
        0,
        ...[';', ',', ' that ', ' which ', ' and ', ' but '].map(s => left.lastIndexOf(s) + 1).filter(i => i > 0)
      );
      const clauseStart = leftStop;
      // expand right to clause boundary (punctuation or end)
      const right = t.slice(cEnd);
      let rightEnd = right.length;
      for (const s of [';', '.', ',', ' and ', ' but ']) {
        const ix = right.indexOf(s);
        if (ix >= 0 && ix < rightEnd) rightEnd = ix;
      }
      const clauseText = t.slice(clauseStart, cEnd + rightEnd).trim();
      if (clauseText.length > 2) {
        items.push({ type: 'risk', text: clauseText, start: sent.start + clauseStart, end: sent.start + clauseStart + clauseText.length });
      }
      break; // one risk tag per sentence
    }
  }

  // DUE: date expression
  const dm = t.match(DUE_RE);
  if (dm) {
    const dStart = dm.index;
    const dText = dm[0];
    items.push({ type: 'due', text: dText, start: sent.start + dStart, end: sent.start + dStart + dText.length });
  }

  return items;
}

export function extract(text) {
  if (!text || !text.trim()) return { items: [], counts: { owner: 0, action: 0, risk: 0, due: 0 } };
  const sentences = tokenize(text);
  const items = [];
  for (const s of sentences) {
    items.push(...analyzeSentence(s));
  }
  // de-dup overlapping spans: prefer owner < due < action < risk by specificity
  items.sort((a, b) => a.start - b.start || (rank(a.type) - rank(b.type)));
  const filtered = [];
  let lastEnd = -1;
  for (const it of items) {
    if (it.start >= lastEnd) {
      filtered.push(it);
      lastEnd = it.end;
    } else if (rank(it.type) < rank((filtered[filtered.length - 1] || {}).type || 'none')) {
      // replace if higher priority and fully covers
      filtered[filtered.length - 1] = it;
      lastEnd = it.end;
    }
  }
  const counts = { owner: 0, action: 0, risk: 0, due: 0 };
  for (const it of filtered) counts[it.type]++;
  return { items: filtered, counts };
}

function rank(type) {
  return { owner: 0, due: 1, action: 2, risk: 3 }[type] ?? 9;
}

// ---- UI ----
const SAMPLE = `Notes — IPM design review follow-up

Owner: Sabarish — close DVP&R item 12 (housing tolerance) by EOW.
The supplier may slip the stator PPAP by two weeks; this is a risk to the 4E0A build.
@Priya to validate thermal cycle results before Friday.
Need to confirm magnet bonding fixture readiness by 6/30.
Open issue: resolver phasing discrepancy is unclear, escalate to Japan team.
Aki to review the drawing release package, due end of month.`;

export function initExtractor(root) {
  const ta = root.querySelector('[data-input]');
  const out = root.querySelector('[data-output]');
  const tally = root.querySelector('[data-tally]');
  const sampleBtn = root.querySelector('[data-sample]');

  function render(text) {
    const { items, counts } = extract(text);
    // build highlighted HTML with escapes
    let html = '';
    let cursor = 0;
    const esc = (s) => s.replace(/[&<>]/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;' }[c]));
    for (const it of items) {
      html += esc(text.slice(cursor, it.start));
      html += `<mark class="ex ex-${it.type}">${esc(it.text)}</mark>`;
      cursor = it.end;
    }
    html += esc(text.slice(cursor)) || '<span class="ex-empty">Paste engineering notes, an email, or meeting minutes on the left. Each recognized owner, action, risk, and due date is highlighted here — instantly, with no model download.</span>';
    out.innerHTML = html;

    tally.querySelector('[data-c=owner]').textContent = counts.owner;
    tally.querySelector('[data-c=action]').textContent = counts.action;
    tally.querySelector('[data-c=risk]').textContent = counts.risk;
    tally.querySelector('[data-c=due]').textContent = counts.due;

    setStatus(root, `Parsed · ${items.length} spans`, 'ok');
  }

  const run = debounce(() => render(ta.value), 90);
  ta.addEventListener('input', run);
  sampleBtn.addEventListener('click', () => { ta.value = SAMPLE; render(SAMPLE); });

  // initial state
  ta.value = SAMPLE;
  render(SAMPLE);
}
