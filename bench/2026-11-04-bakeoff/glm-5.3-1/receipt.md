# Mantis Ring receipt · t_6b1108b81c844c053fd572d101596dbd

REAL RUN · Vultr VX1 sea · 2026-11-03 20:48 UTC

**18 fixed · 0 new · 0 cover-ups · 0 lost**

Final run re-measured by Mantis (no LLM) and compared with the baseline run R0.

- Verdict: **pass** · publishable: yes · stop reason: finish
- Source: sample `lumen`
- Matrix: 16 screens · routes `/`, `/settings.html` · mobile, desktop · light, dark · en, vi
- Started 2026-11-03T20:48:26.116Z · finished 2026-11-03T20:50:53.651Z

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
| 1 | accepted | 16 fixed · 0 new · 0 cover-ups · 0 lost | 10 | forced |
| 2 | accepted | 18 fixed · 0 new · 0 cover-ups · 0 lost | 9.9 | — |

## Models

| Role | Model | Provider | Calls | Prompt | Completion | Reasoning | Cost (list price) |
|---|---|---|---|---|---|---|---|
| fix | `glm-5.3` | Vultr Serverless Inference | 25 | 301900 | 6797 | 2633 | $0.2468 |

Total: 301900 prompt + 6797 completion tokens (2633 reasoning) · $0.2468 · 25 turns · 66 tool calls (0 invalid, 30 errors)
- `glm-5.3`: $0.75 in / $3 out per 1M tokens (catalog list price, 2026-11-03)

## Time

Total 147.5 s · sandbox 0.1 s · clone 0.3 s · serve 0.2 s · baseline 12.7 s · model 106.6 s · tools 5.4 s · checks 19.9 s · verify 0.2 s · proof 1.8 s · copyOut 0.1 s · destroy 0.1 s

## Diff

3 file(s), +18 −17, 6554 bytes · sha256 `cd71fbea828769bff5e9e86dfecf46bf7e64cbd15f6102354de16a0e027c3dad` · applies to the original: yes

## Vision second opinion

Skipped.

## The model's summary

The model's own words, not measured.

```text
All 14 errors and 4 warnings are fixed, verified by check_ui (18 fixed, 0 new, 0 cover-ups).

Main changes in styles.css: promo banner now uses max-width:100% instead of a fixed 600px (fixes horizontal scroll); menu-toggle no longer absolutely positioned so it doesn't overlap the header CTA; "Popular" badge repositioned above the plan button so it doesn't cover its label; hero-note uses the --muted theme token instead of #aaa; #plan-business uses var(--surface) so it themes correctly in dark mode; newsletter button and nav links allowed to wrap/sized naturally (fixes Vietnamese clipped text); save-settings fixed width removed; social links enlarged to 24px tap targets; danger-title uses a --danger-ink token.

In index.html: team photo points to /img/team.svg (the existing asset, fixing the 404), and the lazy hero image has explicit width/height attributes reserving space (fixes the CLS 0.161 layout shift). In settings.js: the script queried a nonexistent #save-btn (null) causing the TypeError — it now targets the real #save-settings button with a null guard.
```

## Containment

Runtime `runsc` · sandbox `ring-d07b5ef9` · 3g RAM, 2 CPUs, 512 processes · network ring-internal → ring-proxy (allowlist) · destroyed · docker ps -a: gone at 2026-11-03T20:50:53.650Z

## Mantis

Mantis 0.7.1 · baseline run `2026-11-03T20-48-26` · final run `2026-11-03T20-50-32` · compared with the baseline run (R0) · prompt ring-2
