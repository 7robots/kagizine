# Roadmap

Single source of truth for planned and deferred work on kagizine.

## Next

Nothing outstanding on the reading experience. Section openers, read state and
self-reporting refreshes are done; continuous flow between stories was
considered and dropped — the white space at the end of a story reads fine, and
buying it back would mean measuring a whole section as one flow.

## Deferred

- **Caching R2 reads at the edge.** `/api/editions/:date` and `/img/:asset` go to
  R2 on every request, which measures at 40–100ms. Worker-generated responses are
  not stored in Cloudflare's cache automatically, so the `max-age` and
  `immutable` headers only ever reach the browser. Wrapping the three read paths
  in `caches.default` would take repeat reads off R2 entirely. Raised by the
  security review as the remaining denial-of-wallet exposure; not urgent at one
  reader, since R2 has no egress fee and both operation classes are far inside
  the free tier.
- **Why the image phase takes 60–120 seconds.** Unexplained, and the same in
  Python and TypeScript. The proxy answers a plain curl in 300–400ms, it is not
  the User-Agent, and it is not CPU (307ms for a whole build). A 10-second
  deadline lost every picture, which is how the current 45s backstop was arrived
  at. The refresh now records median and slowest picture times, so the next
  unattended run should settle it.
- **Dropping the CSP's remaining inline allowance.** `style-src 'unsafe-inline'`
  is needed only because the vendored page-flip library injects its stylesheet as
  a `<style>` element at load; moving that CSS into `public/css/` would let the
  allowance go. `img-src data:` can go at the same time — it is required only by
  `curl.js`, which is dead code (`USE_CURL = false`).
- **Serialising the write path.** `upsertIndex` is a non-atomic
  read-modify-write, so two overlapping refreshes can lose an index entry. Only
  reachable with the refresh token, since the two crons are an hour apart, and the
  one-hour grace window in `prune` already stops the damaging half (deleting a
  concurrent run's pictures). Skipping `prune` on a forced refresh would close the
  rest.
- **An allowlist for the image host.** `<img src>` is scheme-checked now, but any
  http(s) URL a feed supplies is still fetched and republished at
  `/img/<hash>` as a public immutable object. Restricting it to Kagi's proxy host
  would close that as free hosting; the cost is that images vanish silently if
  Kagi changes hosts.
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
  `src/kagi/feed.ts`. Fine while the list is stable; a config binding the day it
  is not.

## Done, for the record

- **Section openers.** A page per section on the verso, so it faces the
  section's first story: turn the page and "Science" appears on the left with its
  lead on the right. Padded with a blank where the opener would otherwise land on
  a recto.
- **Read state.** Stories are marked read on view — in the scrolling article and
  when their page is reached in magazine mode — with a marker in the contents
  list, an unread count, and a mark-all toggle. Held in `localStorage`, keyed by
  date *and* article id (an id is only "section/slug", so the same headline on two
  days would otherwise share a marker), and pruned against the editions the
  server still serves.
- **A refresh that reports itself.** The build decides what is worth telling the
  reader — only it can distinguish a failed feed from an empty section — and puts
  it on the edition as `build.notices`, which the contents page shows when there
  is anything to say. A clean morning says nothing. `GET /api/reports/:date`
  serves the full report, and `/api/health` carries the last build's outcome.

## Accepted, with reasons

- **`/admin/refresh` still answers 405 to a GET when armed and 404 when not**, so
  an observer can tell the route is live. Flagged by the security review; kept
  because distinguishing "wrong token" from "route absent" is worth more when
  debugging by hand than the leak costs, given the token is what actually
  protects it. The length leak in the comparison *was* fixed — it digests both
  sides now.
- **The image host is not allowlisted.** Any http(s) URL a feed supplies is
  fetched and republished under `/img/<hash>`. Restricting it to Kagi's proxy
  would close that, at the cost of images vanishing silently the day Kagi changes
  hosts.

## Known limitations

- **No CI.** The suite runs on demand, not on push, so nothing stops a broken
  commit reaching `main`. Deliberate for now; `vitest` in GitHub Actions would be
  cheap if that changes.

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

- **TypeScript, not Python.** The Worker was Python on Pyodide first. Porting cut
  a refresh from 17.1s of CPU to 307ms, unpinned a runtime that was stuck eleven
  months back, and removed three lockfiles. Note for the record that the argument
  which prompted the port — request latency — was measurement error: with
  connection reuse the Worker adds nothing over a static file, and the 2–4s
  figures came from per-request TLS handshakes on the measuring machine.
- **R2, not D1.** A day's edition is a document the reader consumes whole, and
  the pictures are blobs. Nothing here is relational.
- **No live artifact in Claude CoWork.** Considered and rejected: the artifact
  CSP blocks requests to every external host, so a published page cannot fetch
  this Worker. The only channel would be wrapping it as a claude.ai MCP
  connector and passing pictures through tool calls as base64 — a great deal of
  machinery to end up with a worse copy of the site.
- **Public, no auth.** The content is public news summaries. Adding Okta or magic
  links would protect nothing and cost a secret and a session layer.
