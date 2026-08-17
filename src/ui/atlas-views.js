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

import { atlasViewModel } from './atlas.js';

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

  const caption = document.createElement('div');
  caption.className = 'caption';
  caption.setAttribute('part', 'caption');
  const t = document.createElement('span');
  t.className = 'title';
  t.textContent = title ?? (vm.meta.settingId ? `The ${vm.meta.settingId} world` : 'The known world');
  const sub = document.createElement('span');
  sub.className = 'sub';
  const c = vm.meta.counts;
  sub.textContent = vm.edition === 'player'
    ? `${c.provinces} provinces charted · ${c.powers} powers known`
    : `${c.continents} continents · ${c.provinces} provinces · ${c.powers} powers · ${c.wars} wars`;
  caption.append(t, sub);
  frame.appendChild(caption);

  if (!vm.map.provinces.length) {
    const empty = document.createElement('div');
    empty.className = 'empty';
    empty.textContent = vm.edition === 'player'
      ? 'Nothing charted yet — the map fills as the party travels.'
      : 'This world has no provinces to draw.';
    frame.appendChild(empty);
    root.appendChild(frame);
    return vm;
  }

  const { minX, maxX, minY, maxY } = vm.map.bounds;
  const svg = el('svg', {
    viewBox: `${minX} ${minY} ${maxX - minX} ${maxY - minY}`,
    role: 'img',
    'aria-label': `${t.textContent}: ${c.provinces} provinces`,
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

  const tag = `${prefix}-world-map`;
  if (CE.get(tag)) return { [tag]: CE.get(tag) };

  class WorldMap extends HTMLEl {
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
      renderMap(this.#root, this.#world, { title: this.#title });
    }
  }

  CE.define(tag, WorldMap);
  return { [tag]: WorldMap };
}
