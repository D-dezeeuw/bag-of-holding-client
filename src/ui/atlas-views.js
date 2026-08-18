// === The World Atlas — the elements ===
//
// Thin skins over atlas.js. Each element takes a world (the shape
// `fromCartridge` / `fromAtlasPayload` return), runs it through
// `atlasViewModel`, and draws SVG. No layout maths lives here; no data
// shaping lives here. Registration is a no-op wherever custom elements
// do not exist, so `node --test` imports this file happily — the same
// guard the initiative tracker uses.
//
// Styling: baked shadow-DOM CSS so the atlas is presentable with ZERO
// host CSS, driven by custom properties (--atlas-ink, --atlas-vellum, …)
// and opened up with ::part() hooks for anyone who wants their own
// cartography. The default look is ink on aged vellum, because that is
// what a fantasy world map is; a dark host can flip four variables.

import { atlasViewModel, groupDynasties, relationEdges } from './atlas.js';

const SVG_NS = 'http://www.w3.org/2000/svg';

const ATLAS_CSS = `
  :host {
    display: block;
    --atlas-vellum: #efe4cd;
    --atlas-vellum-deep: #e3d5b8;
    --atlas-ink: #2f2519;
    --atlas-ink-soft: #6b5a44;
    --atlas-rule: #b9a88a;
    --atlas-sea: #aec6cf;
    --atlas-sea-line: #6f93a0;
    --atlas-gate: #7b5ea7;
    --atlas-war: #a8402f;
    --atlas-ally: #4f7a4f;
    --atlas-font: Georgia, 'Iowan Old Style', serif;
    color: var(--atlas-ink);
    font-family: var(--atlas-font);
  }
  .frame {
    position: relative;
    /* The sea, so the letterboxing beside a tall map reads as ocean
       rather than a bar of blank vellum. */
    background: var(--atlas-sea);
    border: 1px solid rgba(47, 37, 25, .35);
    border-radius: 3px;
    box-shadow: inset 0 0 60px rgba(120, 92, 48, .28);
    overflow: hidden;
  }
  /* The drawing letterboxes inside its box (preserveAspectRatio), so the
     height cap fits a whole world on screen without distorting it. */
  svg { display: block; width: 100%; height: auto; max-height: var(--atlas-max-height, 68vh); }
  .legend {
    display: flex; flex-wrap: wrap; gap: .35rem .9rem;
    padding: .55rem .8rem;
    border-top: 1px solid rgba(47, 37, 25, .18);
    background: var(--atlas-vellum-deep);
    font-size: .74rem; letter-spacing: .02em; color: var(--atlas-ink-soft);
  }
  .legend b { font-weight: 600; color: var(--atlas-ink); }
  .swatch { display: inline-block; width: .7rem; height: .7rem; border-radius: 2px;
    margin-right: .3rem; vertical-align: -1px; border: 1px solid rgba(47,37,25,.3); }
  .caption {
    display: flex; justify-content: space-between; align-items: baseline; gap: 1rem;
    padding: .6rem .85rem .4rem;
    font-variant: small-caps; letter-spacing: .06em;
  }
  .caption .title { font-size: 1.02rem; }
  .caption .sub { font-size: .74rem; color: var(--atlas-ink-soft); letter-spacing: .03em;
    font-variant: normal; }
  .landmass { fill: var(--atlas-vellum); stroke: rgba(47, 37, 25, .3); stroke-width: 2; }
  .province { cursor: pointer; }
  .province .cell { stroke: rgba(47, 37, 25, .45); stroke-width: 1.4; }
  .province:hover .cell { stroke: var(--atlas-ink); stroke-width: 3; }
  .province .label { font-size: 13px; fill: var(--atlas-ink); paint-order: stroke;
    stroke: var(--atlas-vellum); stroke-width: 3px; stroke-linejoin: round; }
  .province.unknown .cell { fill: none; stroke-dasharray: 6 5; opacity: .55; }
  .province.unknown .label { display: none; }
  .continent-label { font-size: 26px; letter-spacing: 3px; fill: var(--atlas-ink-soft);
    text-transform: uppercase; paint-order: stroke;
    stroke: var(--atlas-vellum); stroke-width: 4px; stroke-linejoin: round; }
  .lane { stroke: var(--atlas-sea-line); stroke-width: 2.2; fill: none;
    stroke-dasharray: 9 6; opacity: .9; stroke-linecap: round; }
  .border-line { stroke: rgba(47, 37, 25, .35); stroke-width: 1.6; }
  .gate-line { stroke: var(--atlas-gate); stroke-width: 2.4; fill: none;
    stroke-dasharray: 3 6; opacity: .85; stroke-linecap: round; }
  .port { fill: var(--atlas-sea-line); stroke: var(--atlas-vellum); stroke-width: 1; }
  .gate-mark { fill: var(--atlas-gate); }
  .war-mark { fill: none; stroke: var(--atlas-war); stroke-width: 2.6; opacity: .9;
    stroke-dasharray: 5 4; }
  .empty { padding: 2rem .85rem; text-align: center; color: var(--atlas-ink-soft);
    font-style: italic; }
`;

const el = (tag, attrs = {}, text = null) => {
  const node = document.createElementNS(SVG_NS, tag);
  for (const [k, v] of Object.entries(attrs)) node.setAttribute(k, String(v));
  if (text !== null) node.textContent = text;
  return node;
};

/** The small-caps title bar every view wears. `sub` gets the counts. */
function captionFor(vm, title, sub) {
  const caption = document.createElement('div');
  caption.className = 'caption';
  caption.setAttribute('part', 'caption');
  const t = document.createElement('span');
  t.className = 'title';
  t.textContent = title;
  const s = document.createElement('span');
  s.className = 'sub';
  s.textContent = typeof sub === 'function' ? sub(vm.meta.counts) : String(sub ?? '');
  caption.append(t, s);
  return caption;
}

/** A view with nothing to draw says so in words, never as a blank box. */
function emptyNote(text) {
  const empty = document.createElement('div');
  empty.className = 'empty';
  empty.textContent = text;
  return empty;
}

/** Sea lanes and gate hops arc; land borders run straight. */
function linkPath(a, b, kind) {
  if (!a || !b) return null;
  if (kind === 'border') return `M ${a.x} ${a.y} L ${b.x} ${b.y}`;
  const mx = (a.x + b.x) / 2, my = (a.y + b.y) / 2;
  const dx = b.x - a.x, dy = b.y - a.y;
  const bow = kind === 'gate' ? 0.32 : 0.18;
  return `M ${a.x} ${a.y} Q ${mx - dy * bow} ${my + dx * bow} ${b.x} ${b.y}`;
}

function renderMap(root, world, { title }) {
  const vm = atlasViewModel(world);
  root.textContent = '';
  const style = document.createElement('style');
  style.textContent = ATLAS_CSS;
  root.appendChild(style);

  const frame = document.createElement('div');
  frame.className = 'frame';
  frame.setAttribute('part', 'frame');

  const heading = title ?? (vm.meta.settingId ? `The ${vm.meta.settingId} world` : 'The known world');
  const c = vm.meta.counts;
  frame.appendChild(captionFor(vm, heading, () => vm.edition === 'player'
    ? `${c.provinces} provinces charted · ${c.powers} powers known`
    : `${c.continents} continents · ${c.provinces} provinces · ${c.powers} powers · ${c.wars} wars`));

  if (!vm.map.provinces.length) {
    frame.appendChild(emptyNote(vm.edition === 'player'
      ? 'Nothing charted yet — the map fills as the party travels.'
      : 'This world has no provinces to draw.'));
    root.appendChild(frame);
    return vm;
  }

  const { minX, maxX, minY, maxY } = vm.map.bounds;
  const svg = el('svg', {
    viewBox: `${minX} ${minY} ${maxX - minX} ${maxY - minY}`,
    role: 'img',
    'aria-label': `${heading}: ${c.provinces} provinces`,
    part: 'map',
  });

  // Sea first — it is the ground everything else sits on.
  svg.appendChild(el('rect', {
    x: minX, y: minY, width: maxX - minX, height: maxY - minY,
    fill: 'var(--atlas-sea)',
  }));

  // Then the landmasses: one soft shape hugging each continent's
  // provinces, so cells read as territory on land rather than tiles
  // floating in an ocean.
  const cell = vm.map.cell;
  const landLayerBase = el('g', { part: 'landmasses' });
  for (const cont of vm.map.continents) {
    const mine = vm.map.provinces.filter((p) => p.continent === cont.id);
    if (!mine.length) continue;
    const pad = cell * 0.62;
    const lx = Math.min(...mine.map((p) => p.x)) - pad;
    const rx = Math.max(...mine.map((p) => p.x)) + pad;
    const ty = Math.min(...mine.map((p) => p.y)) - pad;
    const by = Math.max(...mine.map((p) => p.y)) + pad;
    landLayerBase.appendChild(el('rect', {
      class: 'landmass', part: 'landmass',
      x: lx, y: ty, width: rx - lx, height: by - ty,
      rx: cell * 0.55, ry: cell * 0.55,
    }));
  }
  svg.appendChild(landLayerBase);

  const laneLayer = el('g', { part: 'lanes' });
  for (const link of vm.map.links) {
    const d = linkPath(link.a, link.b, link.kind);
    if (!d) continue;
    const cls = link.kind === 'sea' ? 'lane' : link.kind === 'gate' ? 'gate-line' : 'border-line';
    laneLayer.appendChild(el('path', { d, class: cls, part: `link-${link.kind}` }));
  }
  svg.appendChild(laneLayer);

  const size = cell * 0.64;
  const landLayer = el('g', { part: 'provinces' });
  for (const p of vm.map.provinces) {
    const g = el('g', { class: `province${p.discovered || vm.edition === 'gm' ? '' : ' unknown'}`,
      part: 'province', 'data-id': p.id });
    g.appendChild(el('rect', {
      class: 'cell', x: p.x - size / 2, y: p.y - size / 2, width: size, height: size,
      rx: size * 0.2, fill: p.color,
      opacity: vm.edition === 'gm' && !p.discovered ? '.5' : '.92',
    }));
    if (p.atWar) {
      g.appendChild(el('circle', { class: 'war-mark', cx: p.x, cy: p.y, r: size * 0.72 }));
    }
    if (p.port) {
      g.appendChild(el('circle', { class: 'port',
        cx: p.x - size / 2 + 5, cy: p.y + size / 2 - 5, r: 5 }));
    }
    if (p.waygate) {
      const t = size / 2 - 4;
      g.appendChild(el('path', { class: 'gate-mark',
        d: `M ${p.x + t - 9} ${p.y - t + 9} l 4.5 -9 l 4.5 9 z` }));
    }
    g.appendChild(el('text', { class: 'label', x: p.x, y: p.y + size / 2 + 16,
      'text-anchor': 'middle', part: 'province-label' }, p.name));
    g.addEventListener('click', () => root.host?.dispatchEvent(new CustomEvent('select-place', {
      detail: { id: p.id, kind: 'province', name: p.name },
      bubbles: true, composed: true,
    })));
    landLayer.appendChild(g);
  }
  svg.appendChild(landLayer);

  for (const cont of vm.map.continents) {
    const mine = vm.map.provinces.filter((p) => p.continent === cont.id);
    if (!mine.length) continue;
    const top = Math.min(...mine.map((p) => p.y));
    svg.appendChild(el('text', {
      class: 'continent-label', x: cont.x, y: top - cell * 0.78,
      'text-anchor': 'middle', part: 'continent-label',
    }, cont.name));
  }

  frame.appendChild(svg);

  const legend = document.createElement('div');
  legend.className = 'legend';
  legend.setAttribute('part', 'legend');
  const climates = [...new Set(vm.map.provinces.map((p) => p.climate).filter(Boolean))].sort();
  for (const climate of climates) {
    const item = document.createElement('span');
    const sw = document.createElement('i');
    sw.className = 'swatch';
    sw.style.background = vm.map.provinces.find((p) => p.climate === climate).color;
    item.append(sw, document.createTextNode(climate));
    legend.appendChild(item);
  }
  const note = document.createElement('span');
  note.append(document.createTextNode('◆ waygate · ● port · '));
  const warSpan = document.createElement('b');
  warSpan.textContent = '○ contested';
  note.appendChild(warSpan);
  legend.append(note);
  frame.appendChild(legend);

  root.appendChild(frame);
  return vm;
}

/**
 * Register the atlas elements where the platform has custom elements.
 * Returns the map of registered classes in a browser and `null` in node,
 * so a host bundle can call it unconditionally.
 */
export function defineWorldAtlas({ prefix = 'boh' } = {}) {
  const CE = globalThis.customElements;
  const HTMLEl = globalThis.HTMLElement;
  if (!CE || !HTMLEl) return null;

  // Every view is the same element with a different renderer: take a
  // world, draw it, emit what was clicked. Sharing the base keeps the
  // host contract identical across views — `setWorld` and nothing else.
  const make = (render) => class AtlasView extends HTMLEl {
    #world = null;
    #root;
    #title = null;

    constructor() {
      super();
      this.#root = this.attachShadow({ mode: 'open' });
    }

    connectedCallback() { this.#render(); }

    /** The host pushes a world (any `fromCartridge`/`fromAtlasPayload` shape). */
    setWorld(world, { title = null } = {}) {
      this.#world = world;
      this.#title = title;
      this.#render();
      return this;
    }

    /** The last view model drawn — handy for hosts that want the numbers. */
    get viewModel() { return this.#world ? atlasViewModel(this.#world) : null; }

    #render() {
      if (!this.#world) return;
      render(this.#root, this.#world, { title: this.#title });
    }
  };

  const registered = {};
  for (const [suffix, render] of [
    ['world-map', renderMap],
    ['power-graph', renderPowers],
    ['dynasty-tree', renderDynasties],
  ]) {
    const tag = `${prefix}-${suffix}`;
    registered[tag] = CE.get(tag) ?? make(render);
    if (!CE.get(tag)) CE.define(tag, registered[tag]);
  }
  return registered;
}

// ── The power graph ─────────────────────────────────────────────────────────
// Factions on a ring, their friendships and grudges drawn as chords. A
// faction's disc grows with the ground it holds, so "who is big" is
// legible before a single label is read; wars ride on top of the enmity
// they came from, thickened by intensity.

const POWER_CSS = `
  .pg-node .disc { stroke: rgba(47,37,25,.55); stroke-width: 2; fill: var(--atlas-vellum); }
  .pg-node.at-war .disc { stroke: var(--atlas-war); stroke-width: 3.5; }
  .pg-node .name { font-size: 15px; fill: var(--atlas-ink);
    paint-order: stroke; stroke: var(--atlas-sea); stroke-width: 3px; stroke-linejoin: round; }
  .pg-node .role { font-size: 11px; fill: var(--atlas-ink-soft);
    paint-order: stroke; stroke: var(--atlas-sea); stroke-width: 3px; stroke-linejoin: round; }
  .pg-node .held { font-size: 13px; fill: var(--atlas-ink-soft); text-anchor: middle; }
  .pg-edge.ally { stroke: var(--atlas-ally); stroke-width: 2; opacity: .8; fill: none; }
  .pg-edge.enemy { stroke: var(--atlas-war); stroke-width: 1.8; opacity: .55; fill: none;
    stroke-dasharray: 7 5; }
  .pg-edge.war { stroke: var(--atlas-war); fill: none; opacity: .95; }
  .pg-edge.war.cold { stroke-width: 2.5; stroke-dasharray: 4 7; }
  .pg-edge.war.raiding { stroke-width: 4; stroke-dasharray: 12 6; }
  .pg-edge.war.open { stroke-width: 6; }
  .war-label { font-size: 12px; fill: var(--atlas-war); text-anchor: middle;
    paint-order: stroke; stroke: var(--atlas-sea); stroke-width: 3px; stroke-linejoin: round; }
`;

function renderPowers(root, world, { title }) {
  const vm = atlasViewModel(world);
  root.textContent = '';
  const style = document.createElement('style');
  style.textContent = ATLAS_CSS + POWER_CSS;
  root.appendChild(style);

  const frame = document.createElement('div');
  frame.className = 'frame';
  frame.setAttribute('part', 'frame');
  frame.appendChild(captionFor(vm, title ?? 'The powers', (c) =>
    vm.edition === 'player'
      ? `${c.powers} powers known · ${c.wars} wars`
      : `${c.powers} powers · ${c.wars} wars`));

  if (!vm.powers.length) {
    frame.appendChild(emptyNote(vm.edition === 'player'
      ? 'No powers known yet — they arrive with the places they hold.'
      : 'This world has no factions.'));
    root.appendChild(frame);
    return vm;
  }

  const S = 900, mid = S / 2, ring = S * 0.33;
  const svg = el('svg', { viewBox: `0 0 ${S} ${S}`, role: 'img', part: 'map',
    'aria-label': `${vm.powers.length} powers and ${vm.wars.length} wars` });
  svg.appendChild(el('rect', { x: 0, y: 0, width: S, height: S, fill: 'var(--atlas-sea)' }));

  const at = new Map();
  vm.powers.forEach((p, i) => {
    const a = (i / vm.powers.length) * Math.PI * 2 - Math.PI / 2;
    at.set(p.id, { x: mid + Math.cos(a) * ring, y: mid + Math.sin(a) * ring, a });
  });
  const chord = (a, b, lift = 0.18) => {
    const mx = (a.x + b.x) / 2, my = (a.y + b.y) / 2;
    return `M ${a.x} ${a.y} Q ${mx + (mid - mx) * lift} ${my + (mid - my) * lift} ${b.x} ${b.y}`;
  };

  // Relations first, wars over them: a war is an enmity that caught fire.
  const edges = el('g', { part: 'relations' });
  for (const rel of relationEdges(vm.powers)) {
    edges.appendChild(el('path', {
      class: `pg-edge ${rel.kind}`, part: `relation-${rel.kind}`,
      d: chord(at.get(rel.from), at.get(rel.to)),
    }));
  }
  svg.appendChild(edges);

  const warLayer = el('g', { part: 'wars' });
  for (const w of vm.wars) {
    const [a, b] = (w.between ?? []).map((id) => at.get(id));
    if (!a || !b) continue;
    warLayer.appendChild(el('path', {
      class: `pg-edge war ${w.intensity ?? 'cold'}`, part: 'war',
      d: chord(a, b, 0.3),
    }));
    const mx = (a.x + b.x) / 2, my = (a.y + b.y) / 2;
    warLayer.appendChild(el('text', {
      class: 'war-label', part: 'war-label',
      x: mx + (mid - mx) * 0.3, y: my + (mid - my) * 0.3 - 6,
    }, w.intensity ?? 'war'));
  }
  svg.appendChild(warLayer);

  const atWar = new Set(vm.wars.flatMap((w) => w.between ?? []));
  const most = Math.max(1, ...vm.powers.map((p) => p.territory.length));
  const nodes = el('g', { part: 'powers' });
  for (const p of vm.powers) {
    const pos = at.get(p.id);
    const r = 26 + (p.territory.length / most) * 26;
    const g = el('g', { class: `pg-node${atWar.has(p.id) ? ' at-war' : ''}`,
      part: 'power', 'data-id': p.id });
    g.appendChild(el('circle', { class: 'disc', cx: pos.x, cy: pos.y, r }));
    g.appendChild(el('text', { class: 'held', x: pos.x, y: pos.y + 5 },
      String(p.territory.length)));
    // Labels sit outside the ring, anchored by the side the node faces —
    // centred text on a left-hand node would lie across its own disc.
    const out = 1 + (r + 22) / ring;
    const lx = mid + (pos.x - mid) * out, ly = mid + (pos.y - mid) * out;
    const cos = Math.cos(pos.a);
    const anchor = cos > 0.25 ? 'start' : cos < -0.25 ? 'end' : 'middle';
    const dy = Math.sin(pos.a) < 0 ? -4 : 12;   // above for the top half
    g.appendChild(el('text', {
      class: 'name', part: 'power-name', x: lx, y: ly + dy, 'text-anchor': anchor,
    }, p.name));
    if (p.leader || p.archetype) {
      g.appendChild(el('text', {
        class: 'role', x: lx, y: ly + dy + 15, 'text-anchor': anchor,
      }, p.leader ? p.leader.name : p.archetype));
    }
    g.addEventListener('click', () => root.host?.dispatchEvent(new CustomEvent('select-power', {
      detail: { id: p.id, name: p.name }, bubbles: true, composed: true,
    })));
    nodes.appendChild(g);
  }
  svg.appendChild(nodes);
  frame.appendChild(svg);

  const legend = document.createElement('div');
  legend.className = 'legend';
  legend.setAttribute('part', 'legend');
  legend.innerHTML = '';
  for (const [text, cls] of [['allied', 'ally'], ['hostile', 'enemy'], ['at war', 'war']]) {
    const item = document.createElement('span');
    const sw = document.createElement('i');
    sw.className = 'swatch';
    sw.style.background = cls === 'ally' ? 'var(--atlas-ally)' : 'var(--atlas-war)';
    sw.style.opacity = cls === 'enemy' ? '.55' : '1';
    item.append(sw, document.createTextNode(text));
    legend.appendChild(item);
  }
  const note = document.createElement('span');
  note.textContent = 'disc size = provinces held';
  legend.appendChild(note);
  frame.appendChild(legend);

  root.appendChild(frame);
  return vm;
}

// ── The dynasty tree ────────────────────────────────────────────────────────
// The closest thing the data has to a family tree, and it is not a
// bloodline — it is a chain of AUTHORITY: a power, the crowns that sit
// under it, and the person wearing each. Drawn in HTML rather than SVG
// because it is mostly text, and text wants to reflow.

const DYNASTY_CSS = `
  .tree { padding: .9rem .95rem 1.2rem; background: var(--atlas-vellum); }
  .house { margin: 0 0 1.15rem; }
  .house:last-child { margin-bottom: 0; }
  .house > .power {
    display: inline-flex; align-items: baseline; gap: .5rem;
    padding: .3rem .7rem; border-radius: 4px;
    background: var(--atlas-vellum-deep); border: 1px solid rgba(47,37,25,.35);
    font-variant: small-caps; letter-spacing: .05em; font-size: .98rem;
  }
  .house > .power .archetype {
    font-variant: normal; letter-spacing: .02em;
    font-size: .74rem; color: var(--atlas-ink-soft); font-style: italic;
  }
  .crowns { list-style: none; margin: 0; padding: 0 0 0 1.25rem; }
  .crowns > li {
    position: relative; padding: .55rem 0 0 1.1rem;
    border-left: 1px solid rgba(47,37,25,.3);
  }
  .crowns > li:last-child { border-left-color: transparent; }
  /* The elbow: a stub of the parent's rule turning into this row. */
  .crowns > li::before {
    content: ''; position: absolute; left: 0; top: 1.05rem; width: .95rem;
    border-top: 1px solid rgba(47,37,25,.3);
  }
  .crowns > li:last-child::after {
    content: ''; position: absolute; left: -1px; top: 0; height: 1.05rem;
    border-left: 1px solid rgba(47,37,25,.3);
  }
  .crown-line { display: flex; flex-wrap: wrap; align-items: baseline; gap: .45rem; }
  .crown-line .house-name { font-size: .95rem; }
  .crown-line .title { font-size: .8rem; color: var(--atlas-ink-soft); }
  .crown-line .seat { font-size: .74rem; color: var(--atlas-ink-soft); font-style: italic; }
  .badge {
    font-size: .66rem; letter-spacing: .06em; text-transform: uppercase;
    padding: .1rem .42rem; border-radius: 999px; border: 1px solid;
  }
  .badge.settled        { color: #3f6b3f; border-color: #3f6b3f; background: #e6efe0; }
  .badge.newly-crowned  { color: #4a5f7a; border-color: #4a5f7a; background: #e2e9f1; }
  .badge.contested      { color: #8a6320; border-color: #8a6320; background: #f4ead3; }
  .badge.usurped        { color: #8d3524; border-color: #8d3524; background: #f6e2dd; }
  .badge.failing        { color: #7a2f2f; border-color: #7a2f2f; background: #f3dada; }
  .ruler { margin: .2rem 0 0 .1rem; font-size: .84rem; }
  .ruler .who { color: var(--atlas-ink); }
  .ruler .voice { color: var(--atlas-ink-soft); font-style: italic; }
  .ruler .wants { display: block; color: var(--atlas-ink-soft); font-size: .78rem; margin-top: .1rem; }
  .vacant { font-size: .8rem; color: var(--atlas-ink-soft); font-style: italic; }
`;

function renderDynasties(root, world, { title }) {
  const vm = atlasViewModel(world);
  root.textContent = '';
  const style = document.createElement('style');
  style.textContent = ATLAS_CSS + DYNASTY_CSS;
  root.appendChild(style);

  const frame = document.createElement('div');
  frame.className = 'frame';
  frame.setAttribute('part', 'frame');
  frame.appendChild(captionFor(vm, title ?? 'Crowns and who wears them',
    (c) => `${c.dynasties} crowns · ${c.powers} powers`));

  if (!vm.dynasties.length) {
    frame.appendChild(emptyNote(vm.edition === 'player'
      ? 'No crowns known yet — thrones arrive with the provinces they rule.'
      : 'This world has no crowns.'));
    root.appendChild(frame);
    return vm;
  }


  const tree = document.createElement('div');
  tree.className = 'tree';
  tree.setAttribute('part', 'tree');

  for (const group of groupDynasties(vm.dynasties, vm.powers)) {
    const house = document.createElement('section');
    house.className = 'house';
    house.setAttribute('part', 'house');

    const power = document.createElement('div');
    power.className = 'power';
    power.setAttribute('part', 'power');
    const pname = document.createElement('span');
    pname.textContent = group.faction ? group.faction.name : 'Sworn to no power';
    power.appendChild(pname);
    if (group.archetype) {
      const a = document.createElement('span');
      a.className = 'archetype';
      a.textContent = group.archetype;
      power.appendChild(a);
    }
    house.appendChild(power);

    const list = document.createElement('ul');
    list.className = 'crowns';
    for (const d of group.crowns) {
      const li = document.createElement('li');
      li.setAttribute('part', 'crown');
      li.dataset.id = d.id;

      const line = document.createElement('div');
      line.className = 'crown-line';
      const hn = document.createElement('b');
      hn.className = 'house-name';
      hn.textContent = d.house;
      line.appendChild(hn);
      if (d.title) {
        const t = document.createElement('span');
        t.className = 'title';
        t.textContent = d.title;
        line.appendChild(t);
      }
      if (d.legitimacy) {
        const b = document.createElement('span');
        b.className = `badge ${d.legitimacy.replace(/\s+/g, '-')}`;
        b.setAttribute('part', 'legitimacy');
        b.textContent = d.legitimacy;
        line.appendChild(b);
      }
      const seatName = vm.map.provinces.find((p) => p.id === d.province)?.name;
      if (seatName) {
        const s = document.createElement('span');
        s.className = 'seat';
        s.textContent = `of ${seatName}`;
        line.appendChild(s);
      }
      li.appendChild(line);

      const ruler = document.createElement('div');
      ruler.className = 'ruler';
      if (d.ruler) {
        const who = document.createElement('span');
        who.className = 'who';
        who.textContent = d.ruler.name;
        ruler.appendChild(who);
        if (d.ruler.voice) {
          const v = document.createElement('span');
          v.className = 'voice';
          v.textContent = ` — ${d.ruler.voice}`;
          ruler.appendChild(v);
        }
        if (d.ruler.wants?.length) {
          const w = document.createElement('span');
          w.className = 'wants';
          w.textContent = `wants: ${d.ruler.wants.join('; ')}`;
          ruler.appendChild(w);
        }
      } else {
        ruler.className = 'vacant';
        ruler.textContent = 'the throne sits empty';
      }
      li.appendChild(ruler);

      li.addEventListener('click', () => root.host?.dispatchEvent(new CustomEvent('select-crown', {
        detail: { id: d.id, house: d.house }, bubbles: true, composed: true,
      })));
      list.appendChild(li);
    }
    house.appendChild(list);
    tree.appendChild(house);
  }

  frame.appendChild(tree);
  root.appendChild(frame);
  return vm;
}
