# Roadmap

Single source of truth for planned and deferred work on kagizine.

## Next

- **Continuous flow across stories.** Every story starts on a fresh page, so a
  two-page story that ends a third of the way down leaves most of a page white.
  A real magazine runs the next piece into that space behind a rule. The
  paginator measures one article at a time, so this means measuring a whole
  section as one flow and recording where each article begins.
- **Section openers.** Four sections with no visual break between them; the
  running head is the only signal you have crossed from World into Science.
- **Read state.** Nothing remembers which stories you have already read, which
  matters more for a daily than for a weekly. Position inside an edition is
  restored by article, but "seen" is not tracked at all.
- **A refresh that reports itself.** `reports/<date>.json` records timings,
  warnings and feed failures, but nothing reads it. A failed feed on a Tuesday
  is currently discovered by noticing a thin edition.

## Deferred

- **Raising the compatibility date.** Pinned at 2025-09-15 between two hard
  walls: newer Pyodide builds fail Cloudflare's deploy-time memory snapshot,
  older ones want module-level `on_fetch` handlers. Both are documented in
  `wrangler.jsonc`. Worth retrying occasionally, since the ceiling is a platform
  bug that may be fixed — but a green deploy proves nothing, so any attempt must
  be followed by a live health check.
- **The WebGL page curl** (`public/js/curl.js`, `USE_CURL = false` in
  `magazine.js`). Complete, and its pieces verify in isolation — WebGL2
  initialises and `Curl.capture` returns a correctly sized raster of a real page
  — but end to end it bails before showing the canvas and the cause was never
  found. StPageFlip's hinged fold is what ships. Inherited from the Economist
  reader along with the rest of magazine mode.
- **Bundled webfonts.** The type is a curated system stack (Iowan Old Style,
  Palatino, Charter) that needs no download. Bundled variable faces would make
  the page identical across machines, and belong with a type-size switcher
  rather than on their own.
- **Image transformations.** Pictures are stored and served at whatever size the
  feed's proxy supplied, up to 5000px wide, to be displayed in a column about
  300px across. R2 plus Cloudflare image transformations would serve sized
  variants and cut the bytes substantially. Not urgent: they are
  content-addressed and cached immutably, so each one is fetched once.
- **Per-section feed choice.** The four feeds are a constant in
  `src/kagi/feed.py`. Fine while the list is stable; a config binding the day it
  is not.

## Known limitations

- **Reading times run short.** A Kagi cluster is a summary — most stories are one
  or two minutes, so an edition is around thirty-five minutes end to end. That is
  the source material, not the reader.
- **Cover art is a photograph, not a cover.** The lead story's picture with the
  masthead over it. It reads as a front page rather than a designed cover, which
  is the honest thing for a daily assembled from a feed.
- **No offline reading.** The original file:// build opened with no server at
  all; hosting it traded that away. A service worker caching the current edition
  would get most of it back.
- **No audio.** The schema carries `audio_asset` and the reader renders a player
  when one is present, inherited from a source that published narration. Kagi's
  feeds do not, so the field is always null.

## Decisions worth not relitigating

- **R2, not D1.** A day's edition is a document the reader consumes whole, and
  the pictures are blobs. Nothing here is relational.
- **No live artifact in Claude CoWork.** Considered and rejected: the artifact
  CSP blocks requests to every external host, so a published page cannot fetch
  this Worker. The only channel would be wrapping it as a claude.ai MCP
  connector and passing pictures through tool calls as base64 — a great deal of
  machinery to end up with a worse copy of the site.
- **Public, no auth.** The content is public news summaries. Adding Okta or magic
  links would protect nothing and cost a secret and a session layer.
