# Roadmap

Single source of truth for planned and deferred work on this reader.

## Next

- **Continuous flow across stories.** Every story currently starts on a fresh
  page, so a two-page story that ends a third of the way down leaves most of a
  page white. A real magazine runs the next piece into that space behind a rule.
  The paginator measures one article at a time, so this means measuring the
  whole section as one flow and recording where each article starts.
- **Section openers.** Four sections, no visual break between them; the running
  head is the only signal you have crossed from World into Science.
- **Read state.** Nothing remembers which stories you have already read, which
  matters more for a daily than a weekly. Position within an edition is
  restored by article, but "seen" is not tracked at all.

## Deferred

- **The WebGL page curl** (`js/curl.js`, `USE_CURL = false` in `js/magazine.js`).
  Complete, and its pieces verify in isolation — WebGL2 initialises and
  `Curl.capture` returns a correctly sized raster of a real page — but end to
  end it bails before showing the canvas and the cause was never found.
  StPageFlip's hinged fold is what ships. Inherited from the Economist reader
  along with the rest of magazine mode.
- **Bundled webfonts.** The type is a curated system stack (Iowan Old Style,
  Palatino, Charter) so it works offline with nothing to download. Bundled
  variable faces would make the page identical across machines, and belong with
  a type-size switcher rather than on their own.
- **Per-section feed choice.** The four feeds are a constant in
  `fetch_kagi.py`. Fine while the list is stable; a config file the day it is
  not.

## Known limitations

- **Reading times run short.** A Kagi cluster is a summary — most stories are
  one or two minutes, so an edition is ~35 minutes end to end. That is the
  source material, not the reader.
- **Cover art is a photograph, not a cover.** The lead story's picture with the
  masthead over it. It reads as a front page rather than a designed cover, which
  is the honest thing for a daily assembled from a feed.
- **No audio.** The schema carries `audio_asset` and the reader renders a player
  when one is present, inherited from a source that published narration. Kagi's
  feeds do not, so the field is always null.
