# Mantis Ring receipt · t_4d45f63d01d80effd16e29b03b7b6fc7

REAL RUN · Vultr VX1 sea · 2026-11-03 20:51 UTC

**18 fixed · 0 new · 0 cover-ups · 0 lost**

Final run re-measured by Mantis (no LLM) and compared with the baseline run R0.

- Verdict: **pass** · publishable: yes · stop reason: finish
- Source: sample `lumen`
- Matrix: 16 screens · routes `/`, `/settings.html` · mobile, desktop · light, dark · en, vi
- Started 2026-11-03T20:51:19.677Z · finished 2026-11-03T20:53:23.102Z

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
| 1 | accepted | 1 fixed · 0 new · 0 cover-ups · 0 lost | 11.7 | forced |
| 2 | accepted | 18 fixed · 0 new · 0 cover-ups · 0 lost | 10 | forced |

## Models

| Role | Model | Provider | Calls | Prompt | Completion | Reasoning | Cost (list price) |
|---|---|---|---|---|---|---|---|
| fix | `glm-5.3` | Vultr Serverless Inference | 30 | 372123 | 7387 | 3096 | $0.3013 |

Total: 372123 prompt + 7387 completion tokens (3096 reasoning) · $0.3013 · 30 turns · 72 tool calls (0 invalid, 34 errors)
- `glm-5.3`: $0.75 in / $3 out per 1M tokens (catalog list price, 2026-11-03)

## Time

Total 123.4 s · sandbox 0.2 s · clone 0.3 s · serve 0.3 s · baseline 12.5 s · model 80.5 s · tools 5.5 s · checks 21.7 s · verify 0.2 s · proof 1.8 s · copyOut 0.1 s · destroy 0.1 s

## Diff

3 file(s), +20 −19, 6861 bytes · sha256 `dfcacf0e82840f224b1aa4b5295015abd79a6ccddd93c3c4c680255ada335cdc` · applies to the original: yes

## Vision second opinion

Skipped.

## The model's summary

The model's own words, not measured.

```text
All 14 errors and 4 warnings are fixed. In styles.css: promo banner now uses max-width:100% instead of fixed 600px (no horizontal scroll); menu-toggle no longer absolutely positioned (no overlap with header CTA); plan badge moved to top-right (no longer covers CTA text); hero-note, #danger-title, #plan-business background and .role switched to theme tokens so dark mode works; nav-links flex-wrap so Vietnamese labels fit; newsletter button and save-settings given auto/min widths so text fits; social links enlarged to 32px tap targets; newsletter radius and role font-size tokens corrected. In settings.js, guard the null addEventListener (wrong selector #save-btn → #save-settings with null check). In index.html, team image points to the existing /img/team.svg, and hero-art img got width/height attributes to reserve space and eliminate layout shift. One check remains unused since the last measurement came back fully clean.
```

## Containment

Runtime `runsc` · sandbox `ring-7f730504` · 3g RAM, 2 CPUs, 512 processes · network ring-internal → ring-proxy (allowlist) · destroyed · docker ps -a: gone at 2026-11-03T20:53:23.101Z

## Mantis

Mantis 0.7.1 · baseline run `2026-11-03T20-51-20` · final run `2026-11-03T20-53-06` · compared with the baseline run (R0) · prompt ring-2
