# Mantis Ring receipt · t_4f043dd8ea0926a24adf3849472b477b

REAL RUN · Vultr VX1 sea · 2026-11-04 08:39 UTC

**23 fixed · 0 new · 0 cover-ups · 0 lost**

Final run re-measured by Mantis (no LLM) and compared with the baseline run R0.

- Verdict: **pass** · publishable: yes · stop reason: finish
- Source: sample `atlas`
- Matrix: 24 screens · routes `/`, `/pricing.html`, `/account.html` · mobile, desktop · light, dark · en, vi
- Started 2026-11-04T08:39:05.703Z · finished 2026-11-04T08:41:42.526Z

## Counts

| | Before (R0) | After (final) |
|---|---|---|
| Errors | 17 | 0 |
| Warnings | 6 | 0 |

Fixed 23 · new 0 · cover-ups 0 · lost 0 · cells compared 24 of 24

### Fixed

- overlap · `/` · `button.chat-bubble` · mobile/light/en, mobile/dark/en, mobile/light/vi, mobile/dark/vi
- contrast · `/` · `main > div.container > p.caption` · mobile/light/en, desktop/light/en, mobile/light/vi, desktop/light/vi
- tap-target · `/` · `div.social > a:nth-of-type(1)` · mobile/light/en, mobile/dark/en, mobile/light/vi, mobile/dark/vi
- console · `/` · `—` · mobile/light/en, mobile/dark/en, mobile/light/vi, mobile/dark/vi
- contrast · `/` · `#promo h3` · mobile/dark/en, desktop/dark/en, mobile/dark/vi, desktop/dark/vi
- theme-leak · `/` · `#promo` · mobile/dark/en, desktop/dark/en, mobile/dark/vi, desktop/dark/vi
- layout-shift · `/` · `h2` · mobile/light/vi, mobile/dark/vi
- page-overflow · `/` · `div.filters` · mobile/light/vi, mobile/dark/vi
- overlap · `/pricing.html` · `button.chat-bubble` · mobile/light/en, mobile/dark/en, mobile/light/vi, mobile/dark/vi
- contrast · `/pricing.html` · `article.card.plan:nth-of-type(1) > p:nth-of-type(1) > span.caption` · mobile/light/en, desktop/light/en, mobile/light/vi, desktop/light/vi
- contrast · `/pricing.html` · `main > div.container > p.caption` · mobile/light/en, desktop/light/en, mobile/light/vi, desktop/light/vi
- tap-target · `/pricing.html` · `div.social > a:nth-of-type(1)` · mobile/light/en, mobile/dark/en, mobile/light/vi, mobile/dark/vi
- console · `/pricing.html` · `—` · mobile/light/en, mobile/dark/en, mobile/light/vi, mobile/dark/vi
- broken-image · `/pricing.html` · `picture.pricing-art > img` · mobile/dark/en, desktop/dark/en, mobile/dark/vi, desktop/dark/vi
- request-failed · `/pricing.html` · `—` · mobile/dark/en, desktop/dark/en, mobile/dark/vi, desktop/dark/vi
- clipped-text · `/pricing.html` · `article.card.plan:nth-of-type(3) > h2.plan__name` · mobile/light/vi, mobile/dark/vi
- layout-shift · `/account.html` · `table.invoices` · mobile/light/en, mobile/dark/en, mobile/light/vi, mobile/dark/vi
- page-overflow · `/account.html` · `table.invoices` · mobile/light/en, mobile/dark/en, mobile/light/vi, mobile/dark/vi
- overlap · `/account.html` · `button.chat-bubble` · mobile/light/en, mobile/dark/en, mobile/light/vi, mobile/dark/vi
- contrast · `/account.html` · `th:nth-of-type(1)` · mobile/light/en, desktop/light/en, mobile/light/vi, desktop/light/vi
- contrast · `/account.html` · `#profile dt:nth-of-type(1)` · mobile/light/en, desktop/light/en, mobile/light/vi, desktop/light/vi
- tap-target · `/account.html` · `div.social > a:nth-of-type(1)` · mobile/light/en, mobile/dark/en, mobile/light/vi, mobile/dark/vi
- console · `/account.html` · `—` · mobile/light/en, mobile/dark/en, mobile/light/vi, mobile/dark/vi

## Gate

Cover-up gate ON · cover-up attempts 0 · lost-control attempts 0 · rolled back 0 · tamper attempts 0

| Check | Decision | Mantis line (vs R0) | Seconds | Note |
|---|---|---|---|---|
| 1 | accepted | 22 fixed · 0 new · 0 cover-ups · 0 lost | 10.5 | — |
| 2 | accepted | 23 fixed · 0 new · 0 cover-ups · 0 lost | 10.5 | — |
| 3 | accepted | 23 fixed · 0 new · 0 cover-ups · 0 lost | 10.6 | — |

## Models

| Role | Model | Provider | Calls | Prompt | Completion | Reasoning | Cost (list price) |
|---|---|---|---|---|---|---|---|
| fix | `deepseek-v4.1-flash-1017` | Vultr Serverless Inference | 27 | 366757 | 28018 | 22789 | $0.0718 |
| vision | `qwen3.8-27b` | Vultr Serverless Inference | 5 | 10092 | 3920 | 1706 | $0.0054 |

Total: 376849 prompt + 31938 completion tokens (24495 reasoning) · $0.0773 · 27 turns · 52 tool calls (0 invalid, 1 errors)
- `deepseek-v4.1-flash-1017`: $0.15 in / $0.6 out per 1M tokens (catalog list price, 2026-11-04)
- `qwen3.8-27b`: $0.15 in / $1 out per 1M tokens (catalog list price, 2026-11-04)

## Time

Total 156.8 s · sandbox 0.2 s · clone 0.2 s · install 0.1 s · serve 1.5 s · baseline 10.8 s · model 98.5 s · tools 2.9 s · checks 31.6 s · verify 0.2 s · proof 1.7 s · copyOut 0.4 s · destroy 0.2 s · vision 8.5 s

## Diff

7 file(s), +37 −8, 7116 bytes · sha256 `401da72afe4618d941b544842231f55a55f370637a20060954483e71ce8d6996` · applies to the original: yes

## Vision second opinion

`qwen3.8-27b` on Vultr Serverless Inference: PASS (agrees with Mantis on 100% of pairs). Mantis's measurement decides.
- `page-overflow on div.filters · / · mobile/light/vi`: Mantis fixed, vision fixed: `Before: the three filter buttons (Tất cả hóa đơn, Đã thanh toán, Quá hạn...) are in a single flex row that overflows the 360px viewport — the third button is clipped at the right edge. After: flex-wrap: wrap was added to .filters, so the buttons now wrap onto two rows, all fully visible within the …`
- `page-overflow on table.invoices · /account.html · mobile/light/en`: Mantis fixed, vision fixed: `Before: the table extended ~404px past the right edge of the 360px viewport, causing page-level horizontal scroll. After: the table is wrapped in a .table-wrap div with overflow-x:auto and uses table-layout:fixed with percentage column widths (18%+30%+17%+19%+16%=100%), so it fits within the viewpo…`
- `overlap on button.chat-bubble · / · mobile/light/en`: Mantis fixed, vision fixed: `The chat bubble and the Accept button no longer overlap; the cookie bar's added right padding on mobile pushes the button clear of the bubble, and both elements are fully visible and usable.`
- `overlap on button.chat-bubble · /pricing.html · mobile/light/en`: Mantis fixed, vision fixed: `` The CSS diff adds `padding-right: 88px` to `.cookie` at max-width 899px, pushing the cookie bar's content (text + Accept button) leftward to clear the chat bubble. In the BEFORE image, the Accept button and chat bubble overlap (red outlines 9 and 10 show the intersection). In the AFTER image, the A… ``

## The model's summary

The model's own words, not measured.

```text
All 17 errors and all 6 warnings from the starting point are now fixed (23 issues resolved, 0 new problems, 0 cover-ups). 

What I changed:

1. **Console errors (all 3 routes)** — `js/drawer.js` called `addEventListener` on `#nav-toggle` without checking it existed. I added a null guard and a small-screen check, so the script no longer throws on pages without the drawer toggle.

2. **Overlap: chat bubble on buttons** — the cookie bar sat under the floating support bubble on mobile. I added right padding to `.cookie` below 900px so the bar's content clears the bubble and taps land on the intended control. Nothing was hidden or shrunk.

3. **Low-contrast text in light mode** — the root cause was one token, `--text-muted: #a1a1aa` (about 2.5:1 on white). I darkened it to `#5b6472`, which passes 4.5:1 on both the white page and the `#f8fafc` card surfaces. This fixed the captions, plan "/month" labels, table headers and profile labels at once.

4. **`#promo` theme leak in dark mode** — `.card--promo` hard-coded `--surface: #ffffff`, so the promo kept a white background while its text switched to light colours. I removed the hard-coded surface so it uses the theme token; it now renders dark with readable text in both schemes.

5. **`div.filters` horizontal overflow on mobile/vi** — the filter row was a non-wrapping flex row with long Vietnamese labels. I added `flex-wrap: wrap` so the row breaks onto multiple lines instead of pushing past the viewport.

6. **Clipped plan name on p
```

## Containment

Runtime `runsc` · sandbox `ring-1fb9b3a2` · 3g RAM, 2 CPUs, 512 processes · network ring-task-1fb9b3a2 (internal, this sandbox only, no host address) → ring-proxy (allowlist) · destroyed · docker ps -a: gone at 2026-11-04T08:41:34.043Z

## Mantis

Mantis 0.7.1 · baseline run `2026-11-04T08-39-07` · final run `2026-11-04T08-41-17` · compared with the baseline run (R0) · prompt ring-2, neutral task message
