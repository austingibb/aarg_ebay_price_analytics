# eBay Price Analytics

A Tampermonkey userscript that scrapes every listing price on an eBay search
results page and overlays a price-analytics widget: mean, median, min/max
sliders, and Tukey (IQR) fences so one absurd listing cannot drag the average.

Install `transpiled_ebay_price_scraper.js` in Tampermonkey. It runs on
`https://www.ebay.com/sch/*`.

## Drift canary

eBay changes its search-results markup regularly, and when it does the script
does not error — it just silently finds zero prices. The `canary/` directory
detects that, and the [triage harness](https://github.com/austingibb/triage_harness)
polls it and can propose a fix.

```
canary/
  live_canary.mjs      layered checks against real eBay over CDP
  dom_probe.mjs        the shared black-box probe (live + tests)
  contract.mjs         the CanaryResult JSON the harness consumes
  presets.mjs          three search URLs with deliberately different param shapes
  script_selectors.mjs reads the userscript's own selectors out of its source
```

The canary never calls into the userscript. It drives the same DOM a browser
would, injects the script, and reads what the script rendered — so the script
needs no test hooks and no refactoring.

It reads `RESULT_CONTAINERS`, `PRICE_SELECTORS`, the card selector, and
`WIDGET_ID` **out of the script source** rather than keeping its own copies. A
private copy would rot: after a fix updated the script, the canary would still be
probing the old markup, and a correct fix could never verify green.

**Layers**, checked in order — the first to fail classifies the run:

| # | Check | Classification if it fails |
|---|-------|---------------------------|
| 1 | Chrome reachable over CDP | `ENVIRONMENT_CDP_DOWN` |
| 2 | eBay served results, not a bot-wall | `ENVIRONMENT_BLOCKED` |
| 3 | Results river present | `URL_OR_STRUCTURE_DRIFT` |
| 4 | ≥20 prices parse | `SCRAPER_SELECTOR_DRIFT` |
| 5 | Widget renders plausible stats | `RENDER_DRIFT` |

Layers 1–2 are environment problems and never reach an automated fixer. That
ordering matters: a captcha interstitial and a dead selector both produce zero
prices, so without the earlier check a fixer would rewrite working selectors to
chase a page that was never broken.

If only some presets fail while others stay healthy, the run is
`CANARY_MAINTENANCE` — a stale preset URL rather than site drift. That is what
the differing param shapes in `presets.mjs` are for.

## Running it

```sh
npm install
npm test                 # mock gate: jsdom + saved fixtures, offline
npm run canary:live      # live: needs Chrome on :9222, prints CanaryResult JSON
```

Start Chrome with remote debugging first for the live canary:

```sh
chrome.exe --remote-debugging-port=9222
```

It reuses your existing browser context, so it inherits your real session — which
is also what keeps eBay from serving a bot interstitial to an obviously
automated profile.

## Refreshing the fixture

`npm test` runs offline against `tests/fixtures/srp-known-good.html`, a captured
SRP snapshot. As eBay's markup moves the snapshot ages, and the gate ends up
testing markup that no longer exists. To refresh it (Chrome on :9222):

```sh
npm run capture-fixture
```

This must go through a real browser. eBay's results river is **not** in the
initial HTML response — it renders after the shell, which is exactly why the
userscript polls for it. Fetching the URL directly would save a shell with no
listings, and the gate would then pass while checking nothing.

Two guards make a bad capture impossible to commit silently: the script counts
prices before writing and refuses to save a fixture with fewer than 20, and
`selectors.test.mjs` independently asserts the committed fixture yields at least
that many.

The script also emits `srp-broken-price-class.html` — the same snapshot with the
price classes renamed — which the tests assert is DETECTED as drift. A gate that
cannot fail proves nothing.

## Tests

| File | Covers |
|------|--------|
| `tests/selectors.test.mjs` | the regression gate: healthy fixture, broken fixture, missing container, bot-wall |
| `tests/parse.test.mjs` | currency parsing, thousands separators, IQR outlier exclusion, unparseable text |

The parsing helpers live inside the script's IIFE and are not importable, so
those tests drive them the way a browser does: build a minimal SRP-shaped page
with known prices and read the numbers back off the rendered widget.
