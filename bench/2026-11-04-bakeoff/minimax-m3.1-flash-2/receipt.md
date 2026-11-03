# Mantis Ring receipt · t_69ea3cf5515497701e0750866b5e693d

REAL RUN · Vultr VX1 sea · 2026-11-03 20:51 UTC

**18 fixed · 0 new · 0 cover-ups · 0 lost**

Final run re-measured by Mantis (no LLM) and compared with the baseline run R0.

- Verdict: **pass** · publishable: yes · stop reason: finish
- Source: sample `lumen`
- Matrix: 16 screens · routes `/`, `/settings.html` · mobile, desktop · light, dark · en, vi
- Started 2026-11-03T20:51:17.106Z · finished 2026-11-03T20:52:28.617Z

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
| 1 | accepted | 12 fixed · 0 new · 0 cover-ups · 0 lost | 10.3 | forced |
| 2 | accepted | 18 fixed · 0 new · 0 cover-ups · 0 lost | 10.9 | — |

## Models

| Role | Model | Provider | Calls | Prompt | Completion | Reasoning | Cost (list price) |
|---|---|---|---|---|---|---|---|
| fix | `minimax-m3.1-flash` | Vultr Serverless Inference | 25 | 304048 | 8781 | 4448 | $0.0687 |

Total: 304048 prompt + 8781 completion tokens (4448 reasoning) · $0.0687 · 25 turns · 55 tool calls (0 invalid, 13 errors)
- `minimax-m3.1-flash`: $0.2 in / $0.9 out per 1M tokens (catalog list price, 2026-11-03)

## Time

Total 71.5 s · sandbox 0.2 s · clone 0.3 s · serve 0.2 s · baseline 12.5 s · model 29.6 s · tools 4 s · checks 21.2 s · verify 0.4 s · proof 2.8 s · copyOut 0.2 s · destroy 0.1 s

## Diff

3 file(s), +16 −15, 7087 bytes · sha256 `860a21f0d6e85f743328511551936323dc232b668a399289752b566acb0912f9` · applies to the original: yes

## Vision second opinion

Skipped.

## The model's summary

The model's own words, not measured.

```text
Fixed all 14 errors and 4 warnings on both routes across mobile/desktop, light/dark, en/vi.

- Layout/overflow: promo banner now uses width:100%/max-width:600px instead of a fixed 600px; nav links wrap instead of being clipped with overflow:hidden.
- Overlaps: the mobile menu toggle is no longer absolutely positioned over the header CTA; the "popular" badge on the Pro plan is taken out of absolute positioning so it no longer covers the CTA text.
- Contrast/theme leaks: hero note and danger-zone title now use theme tokens (--muted, --danger-ink); the Business plan uses var(--surface) instead of hard-coded #fff, fixing its dark-mode text colours and background.
- Clipped text: newsletter submit button and the Vietnamese save button now size to their content; Vietnamese nav links wrap.
- Broken image: team photo now points to an existing asset (team.svg).
- Console error: settings.js queried a non-existent #save-btn; it now targets #save-settings.
- Layout shift: hero image has intrinsic width/height and an aspect-ratio so space is reserved.
- Tap targets: social icon links enlarged to 24×24 with centred icons.

Final check reports 18 fixed, 0 new, 0 cover-ups, 0 remaining issues.
```

## Containment

Runtime `runsc` · sandbox `ring-433ca217` · 3g RAM, 2 CPUs, 512 processes · network ring-internal → ring-proxy (allowlist) · destroyed · docker ps -a: gone at 2026-11-03T20:52:28.616Z

## Mantis

Mantis 0.7.1 · baseline run `2026-11-03T20-51-17` · final run `2026-11-03T20-52-13` · compared with the baseline run (R0) · prompt ring-2
