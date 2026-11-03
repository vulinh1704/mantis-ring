# Mantis Ring receipt · t_2d8bf3714652ec6d98726a0ba7b622ce

REAL RUN · Vultr VX1 sea · 2026-11-03 20:46 UTC

**18 fixed · 0 new · 0 cover-ups · 0 lost**

Final run re-measured by Mantis (no LLM) and compared with the baseline run R0.

- Verdict: **pass** · publishable: yes · stop reason: finish
- Source: sample `lumen`
- Matrix: 16 screens · routes `/`, `/settings.html` · mobile, desktop · light, dark · en, vi
- Started 2026-11-03T20:46:27.669Z · finished 2026-11-03T20:47:14.021Z

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
| 1 | accepted | 18 fixed · 0 new · 0 cover-ups · 0 lost | 9.7 | forced |

## Models

| Role | Model | Provider | Calls | Prompt | Completion | Reasoning | Cost (list price) |
|---|---|---|---|---|---|---|---|
| fix | `minimax-m3.1-flash` | Vultr Serverless Inference | 18 | 244415 | 4541 | 1250 | $0.0530 |

Total: 244415 prompt + 4541 completion tokens (1250 reasoning) · $0.0530 · 18 turns · 47 tool calls (0 invalid, 9 errors)
- `minimax-m3.1-flash`: $0.2 in / $0.9 out per 1M tokens (catalog list price, 2026-11-03)

## Time

Total 46.4 s · sandbox 0.2 s · clone 0.2 s · serve 0.2 s · baseline 12.6 s · model 17.8 s · tools 3.3 s · checks 9.7 s · verify 0.2 s · proof 1.8 s · copyOut 0.1 s · destroy 0.1 s

## Diff

3 file(s), +26 −23, 6979 bytes · sha256 `13b382f5ccc6d79e8a95d7dd7a5b12d9ddb3dd07fc4d549eabbd50861f9daa06` · applies to the original: yes

## Vision second opinion

Skipped.

## The model's summary

The model's own words, not measured.

```text
Fixed all 14 reported errors and all 4 warnings. Key changes: made the promo banner responsive and prevented mobile header/control overlaps; moved the popular badge into normal flow so it no longer covers the CTA; replaced hard-coded colours with theme tokens for the hero note, Business plan, and danger-zone title; restored the missing team image and gave the hero art intrinsic dimensions to prevent layout shift; allowed navigation, newsletter, and save-button text to wrap instead of clipping; fixed the settings page null-element script error; and enlarged the social media tap targets. The automated check reports 18 fixed issues, with no new issues or cover-ups, and no known remaining UI problems.
```

## Containment

Runtime `runsc` · sandbox `ring-f0280ea0` · 3g RAM, 2 CPUs, 512 processes · network ring-internal → ring-proxy (allowlist) · destroyed · docker ps -a: gone at 2026-11-03T20:47:14.021Z

## Mantis

Mantis 0.7.1 · baseline run `2026-11-03T20-46-28` · final run `2026-11-03T20-46-58` · compared with the baseline run (R0) · prompt ring-2
