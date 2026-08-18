# The World Atlas

Four views onto a generated world, and two ways to feed them: a baked
cartridge (the GM's spoiler view) or a live campaign from the MCP server
(only what the table has found). The views are plain custom elements, so
they drop into any host — [`examples/atlas.html`](../examples/atlas.html)
is the reference page, and an admin dashboard embeds the same four tags.

```
                 ┌── fromCartridge(cart, { edition })   ← a world-NNNN.json on disk
world data ──────┤
                 └── fromAtlasPayload(await world_atlas) ← one campaign, live

                          ↓
                 atlasViewModel(world)   ← pure, no DOM, node-testable
                          ↓
   <boh-world-map>  <boh-power-graph>  <boh-dynasty-tree>   ·   <boh-local-map>
```

## The four views

| Element | Shows | Fed by | Click event |
| --- | --- | --- | --- |
| `<boh-world-map>` | continents, provinces tinted by climate, sea lanes, waygate arcs, faction territory, war fronts | `setWorld(world)` | `select-place` → `{ id, kind, name }` |
| `<boh-power-graph>` | factions on a ring, alliance and enmity as chords, wars by intensity, disc size = territory | `setWorld(world)` | `select-power` → `{ id, name }` |
| `<boh-dynasty-tree>` | crowns filed under the power behind them, with title, legitimacy and the face on the throne | `setWorld(world)` | `select-crown` → `{ id, house }` |
| `<boh-local-map>` | one settlement's plots or one dungeon's rooms, doors and locks, boss/foes/loot pips | `setLocal(layout, { npcs })` | `select-cell` → `{ id, kind, label }` |

Every event is `composed: true`, so it crosses the shadow boundary and a
host can listen on the element itself. Each element also exposes
`.viewModel` — the same normalized object the renderer drew, for hosts
that want the numbers rather than the picture.

## There are no coordinates, and that is deliberate

A geo node carries `id, name, kind, seed, hook, climate, port, waygate,
parent, detail, discovered` — and **no x/y**. The world is a graph, not a
map; travel is priced in days, not distance. Baking coordinates in would
change the cartridge format and its digest for a view concern.

So the atlas invents them at view time. `worldLayout(geo, { seed })`
reuses `placeOnGrid` — the same connected self-avoiding walk that lays out
dungeons and settlements — with a per-continent rng seeded from the
continent's own seed. Same world, same map, forever.

The layout is also **stable under fog**, which is a stronger property and
took three tries to get right:

- Slots come from the **id** (`continent-2.province-3` → slot 3), never
  from array order, so a province keeps its square when its neighbours are
  absent.
- Each continent draws from its **own** rng stream, so a hidden continent
  cannot shift the ones already drawn.
- The ring is sized by `worldShape.continents` — a COUNT the player cut
  carries on purpose — so finding a new coast fills the map in rather than
  redrawing it.

Break any one of those and a province moves as the party explores, which
reads as the world rearranging itself.

## The two editions

`player` **deletes**; it does not dim. A secret that never leaves the
server cannot leak through a stylesheet, a DOM inspector, or a screenshot.

| | `gm` | `player` |
| --- | --- | --- |
| undiscovered nodes | ghosted, present | **absent** |
| edges touching them | drawn | **absent** |
| powers holding no known ground | shown | **absent** |
| a faction's `territory`, a war's `front`, a legend's `sites` | whole | trimmed to visible provinces |
| `allies` / `enemies` / crown `factionRelations` | whole | trimmed to visible powers |
| `legend.kernelOfTruth`, `legend.payoff` | shown | **stripped** |
| `crown.stanceOnThreat` | shown | **stripped** |
| `npc.wants` | shown | **stripped** |
| `npc.seatOf` for an unfound throne | shown | nulled |
| `worldShape.continents` | — | **kept** (a count, never a name) |

The trimming matters as much as the deletion: an entity that survives the
cut used to carry the ids of places nobody had been to, and an id is a
name one lookup away the moment the party walks in.

## Feeding it: a baked cartridge (GM / spoiler)

```js
import { fromCartridge, atlasViewModel, defineWorldAtlas } from '@zeeuw/bag-of-holding-client';

defineWorldAtlas();                       // registers all four tags; no-op in node

const cart = JSON.parse(await (await fetch('/worlds/world-1234.json')).text());
document.querySelector('boh-world-map').setWorld(fromCartridge(cart, { edition: 'gm' }));
```

`fromCartridge` also takes `{ ledger, fold }` to apply a campaign's world
patches before drawing, so a GM view can show what one table changed.

## Feeding it: a live campaign (player)

The MCP server's `world_atlas({ campaign })` returns the campaign's world
already narrowed and already cut — the pinned revision's geography, folded
through that campaign's ledger, holding only what the table has found. A
node counts as found when the campaign observed it (`world_node` called
**with** the campaign, or a patch written about it), when the ledger says
so, or when it is the landing frozen into the pin at `world_begin`. The
landmass under a known province comes with it; a route appears once both
ends are known.

```js
import { fromAtlasPayload } from '@zeeuw/bag-of-holding-client';

const payload = await callWorldAtlas('curse-of-the-fen');   // see the proxy below
document.querySelector('boh-world-map').setWorld(fromAtlasPayload(payload));
```

`fromAtlasPayload` re-applies `playerCut` to anything labelled `player`.
On a correct feed that is a no-op — every node in it is already discovered
— so it costs nothing, and the label stops being a promise taken on faith.

There is no `gm` option on `world_atlas`, on purpose: a model may be
rendering it onto a screen the players are looking at. The spoiler view has
two other homes — the cartridge itself, and `world_export({ edition: 'gm' })`.

## Embedding in an admin page

The elements are framework-agnostic custom elements. Three things a host
needs to know:

**1. `setWorld` is a method, not an attribute.** In React that means a ref
(or a `useEffect` on the payload), because JSX props do not reach methods:

```jsx
import { useEffect, useRef } from 'react';
import { defineWorldAtlas, fromAtlasPayload } from '@zeeuw/bag-of-holding-client';

defineWorldAtlas();

export function WorldMap({ payload, onPlace }) {
  const ref = useRef(null);
  useEffect(() => { if (payload) ref.current?.setWorld(fromAtlasPayload(payload)); }, [payload]);
  useEffect(() => {
    const el = ref.current, h = (e) => onPlace?.(e.detail);
    el?.addEventListener('select-place', h);
    return () => el?.removeEventListener('select-place', h);
  }, [onPlace]);
  return <boh-world-map ref={ref} />;
}
```

**2. Never put the tenant token in the browser.** The MCP endpoint is
`POST /mcp/<token>`, the token IS the tenant, and the MCP transport path
sends no CORS headers — a browser cannot reach it cross-origin and should
not be trying. Call it from the admin's own server and hand the page the
payload:

```js
// admin server — the token stays here, never in a bundle
import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { StreamableHTTPClientTransport } from '@modelcontextprotocol/sdk/client/streamableHttp.js';

const url = new URL(`${process.env.BOH_MCP_URL}/mcp/${process.env.BOH_TOKEN}`);

app.get('/api/atlas/:campaign', async (req, res) => {
  const client = new Client({ name: 'boh-admin', version: '1.0.0' });
  await client.connect(new StreamableHTTPClientTransport(url));
  try {
    const out = await client.callTool({
      name: 'world_atlas', arguments: { campaign: req.params.campaign },
    });
    res.json(out.structuredContent);       // exactly what fromAtlasPayload wants
  } finally { await client.close(); }
});
```

The server is stateless — a fresh `McpServer` per request — so a connection
per call is honest rather than wasteful, and nothing is lost by closing it.

If the admin backend is not Node, call the endpoint directly: it is plain
JSON-RPC over `POST /mcp/<token>` and needs no `initialize` handshake. One
wrinkle to plan for — the streamable-HTTP transport answers with
`text/event-stream`, not JSON, so read the `data:` line rather than parsing
the body whole:

```
POST /mcp/<token>
accept: application/json, text/event-stream
{"jsonrpc":"2.0","id":1,"method":"tools/call",
 "params":{"name":"world_atlas","arguments":{"campaign":"curse-of-the-fen"}}}

→ 200 text/event-stream
  event: message
  data: {"result":{"content":[…],"structuredContent":{…}},"jsonrpc":"2.0","id":1}
```

That proxy is also the right place to decide who may see which campaign —
the MCP server authorizes the *token*, not the person holding the browser.

**3. Theme with custom properties, style parts with `::part()`.** The
shadow DOM keeps host CSS out; these are the seams left open:

```css
boh-world-map, boh-power-graph, boh-dynasty-tree, boh-local-map {
  --atlas-vellum: #efe4cd;      /* parchment */
  --atlas-vellum-deep: #e3d5b8; /* legend bar, floor-plan ground */
  --atlas-ink: #2f2519;         /* type */
  --atlas-ink-soft: #6b5a44;    /* captions, subtitles */
  --atlas-rule: #b9a88a;        /* hairlines */
  --atlas-sea: #aec6cf;         /* ocean */
  --atlas-sea-line: #6f93a0;    /* sea lanes */
  --atlas-gate: #7b5ea7;        /* waygate arcs */
  --atlas-war: #a8402f;         /* fronts, enmity, locked doors */
  --atlas-ally: #4f7a4f;        /* alliances, entrances */
  --atlas-font: Georgia, serif;
  --atlas-max-height: 68vh;     /* the svg's ceiling inside your layout */
}
boh-world-map::part(province) { stroke-width: 2; }
boh-world-map::part(link-gate) { stroke-dasharray: 2 6; }
```

Parts exposed, by view:

- **shared** — `frame`, `caption`, `legend`, `map`
- **world map** — `landmasses`, `landmass`, `lanes`, `link-<kind>`
  (`border` · `road` · `sea` · `gate`), `provinces`, `province`,
  `province-label`, `continent-label`
- **power graph** — `relations`, `relation-<kind>` (`ally` · `enemy`),
  `wars`, `war`, `war-label`, `powers`, `power`, `power-name`
- **dynasty tree** — `tree`, `house`, `crown`, `legitimacy`
- **local map** — `cells`, `cell`, `cell-label`, `links`, `pip-<tag>`
  (`boss` · `foes` · `loot`)

`defineWorldAtlas({ prefix })` renames all four tags at once if `boh-`
collides with something the host already registers. Calling it twice is
safe — an already-registered tag is left alone — and it returns `null`
under node, where `customElements` does not exist, so importing the module
server-side is harmless.

## Local maps

`<boh-local-map>` takes a layout, not a world, because a floor plan is not
a world:

```js
import { generateDungeon, settlementLayout, mulberry32 } from '@zeeuw/bag-of-holding-client';

const dungeon = generateDungeon(1234, {
  rng: mulberry32(1234),
  statBlockFor: (id, { isBoss } = {}) => yourBestiary(id, isBoss),
  defaultEnemyIds: ['skeleton', 'ghoul', 'wight'],
});
document.querySelector('boh-local-map').setLocal(dungeon, { title: 'The Sunken Vault' });

// or a town, same element
document.querySelector('boh-local-map').setLocal(settlementLayout(1234, { kind: 'town' }));
```

It accepts either shape — a settlement's `{ plots }` or a dungeon's
`{ rooms }` — and normalizes both to cells and links. Dungeon rooms have
carried `pos` since 0.38.0 (the generator always computed it; it just was
not kept). Doors are deduped, locks draw as red dashed links, and boss /
foes / loot become ★ / ✦ / ◈ pips.

## Reference page

[`examples/atlas.html`](../examples/atlas.html) bakes a world in the page —
no install, no server. Dials for seed, continents and provinces; a GM ↔
Player toggle; a "discover a province" button that shows the fog opening
one square at a time; and all four views as tabs. It reads URL parameters
(`?seed=&continents=&provinces=&edition=&discover=&view=`), so a particular
world and view is a link you can send someone.
