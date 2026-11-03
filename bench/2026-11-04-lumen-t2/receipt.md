# Mantis Ring receipt · t_df6d4fade64325f900b7ac5bdf50ea52

REAL RUN · Vultr VX1 sea · 2026-11-03 20:43 UTC

**18 fixed · 0 new · 0 cover-ups · 0 lost**

Final run re-measured by Mantis (no LLM) and compared with the baseline run R0.

- Verdict: **pass** · publishable: yes · stop reason: finish
- Source: sample `lumen`
- Matrix: 16 screens · routes `/`, `/settings.html` · mobile, desktop · light, dark · en, vi
- Started 2026-11-03T20:43:06.047Z · finished 2026-11-03T20:45:03.384Z

## Counts

| | Before (R0) | After (final) |
|---|---|---|
| Errors | 14 | 0 |
| Warnings | 4 | 0 |

Fixed 18 · new 0 · cover-ups 0 · lost 0 · cells compared 16 of 16

### Fixed

- layout-shift · `/` · `#hero-art` · mobile/light/en, mobile/dark/en, desktop/light/en, desktop/dark/en, mobile/light/vi, mobile/dark/vi, desktop/light/vi, desktop/dark/vi
- page-overflow · `/` · `#promo-banner` · mobile/light/en, mobile/dark/en, mobile/light/vi, mobile/dark/vi
- overlap · `/` · `#menu-toggle` · mobile/light/en, mobile/dark/en, mobile/light/vi, mobile/dark/vi
- overlap · `/` · `#popular-badge` · mobile/light/en, mobile/dark/en, mobile/light/vi, mobile/dark/vi
- contrast · `/` · `#hero-note` · mobile/light/en, desktop/light/en, mobile/light/vi, desktop/light/vi
- tap-target · `/` · `#social-links a:nth-of-type(1)` · mobile/light/en, mobile/dark/en, mobile/light/vi, mobile/dark/vi
- broken-image · `/` · `#team-photo` · mobile/light/en, mobile/dark/en, desktop/light/en, desktop/dark/en, mobile/light/vi, mobile/dark/vi, desktop/light/vi, desktop/dark/vi
- request-failed · `/` · `—` · mobile/light/en, mobile/dark/en, desktop/light/en, desktop/dark/en, mobile/light/vi, mobile/dark/vi, desktop/light/vi, desktop/dark/vi
- contrast · `/` · `#plan-business h3.plan-name` · mobile/dark/en, desktop/dark/en, mobile/dark/vi, desktop/dark/vi
- contrast · `/` · `#plan-business span.amount` · mobile/dark/en, desktop/dark/en, mobile/dark/vi, desktop/dark/vi
- contrast · `/` · `#plan-business span.per` · mobile/dark/en, desktop/dark/en, mobile/dark/vi, desktop/dark/vi
- theme-leak · `/` · `#plan-business` · mobile/dark/en, desktop/dark/en, mobile/dark/vi, desktop/dark/vi
- clipped-text · `/` · `#newsletter-submit` · mobile/light/vi, mobile/dark/vi, desktop/light/vi, desktop/dark/vi
- clipped-text · `/` · `#nav-links` · desktop/light/vi, desktop/dark/vi
- console · `/settings.html` · `—` · mobile/light/en, mobile/dark/en, desktop/light/en, desktop/dark/en, mobile/light/vi, mobile/dark/vi, desktop/light/vi, desktop/dark/vi
- contrast · `/settings.html` · `#danger-title` · mobile/dark/en, desktop/dark/en, mobile/dark/vi, desktop/dark/vi
- theme-leak · `/settings.html` · `#danger-title` · mobile/dark/en, desktop/dark/en, mobile/dark/vi, desktop/dark/vi
- clipped-text · `/settings.html` · `#save-settings` · mobile/light/vi, mobile/dark/vi, desktop/light/vi, desktop/dark/vi

## Gate

Cover-up gate ON · cover-up attempts 0 · lost-control attempts 0 · rolled back 0 · tamper attempts 0

| Check | Decision | Mantis line (vs R0) | Seconds | Note |
|---|---|---|---|---|
| 1 | accepted | 16 fixed · 0 new · 0 cover-ups · 0 lost | 9.8 | forced |
| 2 | accepted | 18 fixed · 0 new · 0 cover-ups · 0 lost | 9.6 | — |

## Models

| Role | Model | Provider | Calls | Prompt | Completion | Reasoning | Cost (list price) |
|---|---|---|---|---|---|---|---|
| fix | `deepseek-v4.1-flash-1017` | Vultr Serverless Inference | 18 | 242354 | 11728 | 7970 | $0.0434 |
| vision | `qwen3.8-27b` | Vultr Serverless Inference | 4 | 8071 | 1825 | 1260 | $0.0030 |

Total: 250425 prompt + 13553 completion tokens (9230 reasoning) · $0.0464 · 18 turns · 33 tool calls (0 invalid, 1 errors)
- `deepseek-v4.1-flash-1017`: $0.15 in / $0.6 out per 1M tokens (catalog list price, 2026-11-03)
- `qwen3.8-27b`: $0.15 in / $1 out per 1M tokens (catalog list price, 2026-11-03)

## Time

Total 117.3 s · sandbox 0.1 s · clone 0.2 s · serve 0.2 s · baseline 10.7 s · model 77.3 s · tools 2.4 s · checks 19.4 s · verify 0.2 s · proof 1.8 s · copyOut 0.4 s · destroy 0.1 s · vision 4.3 s

## Diff

3 file(s), +26 −24, 7719 bytes · sha256 `cb5e72ce85dcdaf5f9f38bdd025b646c62f14213811fb0ce70a530fd3644a599` · applies to the original: yes

## Vision second opinion

`qwen3.8-27b` on Vultr Serverless Inference: PASS (agrees with Mantis on 100% of pairs). Mantis's measurement decides.
- `page-overflow on #promo-banner · / · mobile/light/en`: Mantis fixed, vision fixed: `` Before: the #promo-banner (`.promo`) had a fixed `width: 600px` on a 360px viewport, causing it to overflow 240px past the right edge. The BEFORE image shows the banner text 'See plans' being cut off at the right edge and the 'Start' button partially hidden. After: the CSS was changed to `width: 10… ``
- `overlap on #menu-toggle · / · mobile/light/en`: Mantis fixed, vision fixed: `In the BEFORE image, the #menu-toggle (hamburger icon) and #header-cta (Start button) are overlapping, with the measuring tool showing a 36x36px intersection area marked with red outlines. In the AFTER image, the 'Start free' button and the hamburger menu icon are clearly separated with visible spa…`
- `overlap on #popular-badge · / · mobile/light/en`: Mantis fixed, vision fixed: `In the BEFORE image, the 'Most popular' badge sits directly on top of the 'Start 14-day free trial' button text, covering 3 of 5 sampled points. In the AFTER image, the badge has been repositioned to the top-right corner of the Pro card, completely clear of the CTA button. The button text 'Start 14…`
- `clipped-text on #newsletter-submit · / · mobile/light/vi`: Mantis fixed, vision fixed: `Before: the button text is clipped on both sides showing 'ăng ký nhận bản t' (missing 'Đ' on left and 'in' on right). After: the full text 'Đăng ký nhận bản tin' is completely visible, centered, and readable within the button, which now spans the full width of its container.`

## The model's summary

The model's own words, not measured.

```text
All 14 errors and 4 warnings are fixed (18 issues), with 0 new issues and no cover-ups reported.

What I changed:
- **Promo banner overflow**: `.promo` no longer a fixed `600px` width; now `width: 100%; max-width: 600px`, so it fits mobile without horizontal scroll.
- **Header overlap (menu-toggle vs header CTA)**: removed the absolute positioning of the menu toggle on small screens; the header row now wraps in normal flow instead of stacking controls on top of each other.
- **Popular badge over the Pro CTA**: removed the mobile rule that re-centered the badge over the button, so it stays above the plan card rather than covering the CTA text.
- **Hero note contrast**: `#aaa` replaced with the theme's `--muted` token (works in light and dark).
- **Broken team photo**: `src="/img/team.jpg"` (404) changed to the existing `/img/team.svg`.
- **Business plan dark-mode theme leak / contrast**: hard-coded `background: #fff` replaced with `var(--surface)`, so text tokens resolve correctly in dark mode.
- **Nav links clipped (vi/desktop)**: dropped the fixed `max-width: 420px`, `overflow: hidden` and `white-space: nowrap`; links now wrap with flexible gaps.
- **Newsletter submit clipped (vi)**: button no longer a fixed narrow width with hidden overflow; it takes `min-width` and can grow/wrap, and the input/button go full width on small screens.
- **Settings console error**: `settings.js` queried `#save-btn`, which doesn't exist; it now uses `#save-settings` and guards for a missing ele
```

## Containment

Runtime `runsc` · sandbox `ring-5fbee8ca` · 3g RAM, 2 CPUs, 512 processes · network ring-internal → ring-proxy (allowlist) · destroyed · docker ps -a: gone at 2026-11-03T20:44:59.071Z

## Mantis

Mantis 0.7.1 · baseline run `2026-11-03T20-43-06` · final run `2026-11-03T20-44-41` · compared with the baseline run (R0) · prompt ring-2
