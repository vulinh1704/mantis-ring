# Mantis Ring receipt · t_6951df433c058b1d37ce69ef67cafdf9

REAL RUN · Vultr VX1 sea · 2026-11-03 20:48 UTC

**18 fixed · 0 new · 0 cover-ups · 0 lost**

Final run re-measured by Mantis (no LLM) and compared with the baseline run R0.

- Verdict: **pass** · publishable: yes · stop reason: finish
- Source: sample `lumen`
- Matrix: 16 screens · routes `/`, `/settings.html` · mobile, desktop · light, dark · en, vi
- Started 2026-11-03T20:48:28.741Z · finished 2026-11-03T20:50:09.302Z

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
| 1 | accepted | 15 fixed · 0 new · 0 cover-ups · 0 lost | 9.8 | forced |
| 2 | accepted | 18 fixed · 0 new · 0 cover-ups · 0 lost | 9.4 | — |
| 3 | accepted | 18 fixed · 0 new · 0 cover-ups · 0 lost | 9.6 | — |

## Models

| Role | Model | Provider | Calls | Prompt | Completion | Reasoning | Cost (list price) |
|---|---|---|---|---|---|---|---|
| fix | `deepseek-v4.1-flash-1017` | Vultr Serverless Inference | 25 | 288194 | 15184 | 11444 | $0.0523 |

Total: 288194 prompt + 15184 completion tokens (11444 reasoning) · $0.0523 · 25 turns · 42 tool calls (0 invalid, 0 errors)
- `deepseek-v4.1-flash-1017`: $0.15 in / $0.6 out per 1M tokens (catalog list price, 2026-11-03)

## Time

Total 100.6 s · sandbox 0.2 s · clone 0.3 s · serve 0.3 s · baseline 12.5 s · model 52.2 s · tools 2.9 s · checks 28.9 s · verify 0.3 s · proof 2.6 s · copyOut 0.1 s · destroy 0.1 s

## Diff

4 file(s), +22 −23, 6989 bytes · sha256 `7f9e909383b4c061e9608d21e9d19743bd702a2178be4b2b8b5a8a03f133010c` · applies to the original: yes

## Vision second opinion

Skipped.

## The model's summary

The model's own words, not measured.

```text
All 14 errors and 4 warnings from the starting point are now resolved (18 issues fixed, no new problems, no cover-ups).

What I changed:
- **Mobile horizontal overflow**: `#promo-banner` now uses `width: 100%; max-width: 600px` instead of a fixed 600px.
- **Header control overlap**: the mobile `#menu-toggle` no longer uses absolute positioning; it sits in the flex row with `margin-left: auto`, so it can't overlap `#header-cta`.
- **Popular badge over the Pro CTA**: removed the mobile rule that moved the badge to a position covering "Start 14-day free trial"; it now stays in normal layout above the button.
- **Contrast / theme leaks**: `#hero-note` now uses the `--muted` token instead of `#aaa`; `#plan-business` uses `--surface` instead of hard-coded `#fff` (which fixes all its dark-mode text contrasts); `#danger-title` uses the `--danger-ink` token.
- **Missing image**: `/img/team.jpg` doesn't exist, so the portrait now points at the existing `/img/team.svg`.
- **Layout shift (CLS)**: `#hero-art` is loaded directly as a real `<img>` with intrinsic `width`/`height` rather than being injected later by JS, so space is reserved from the start.
- **Vietnamese text clipping**: removed forced `width`/`overflow: hidden`/`nowrap` from `#newsletter-submit`, allowed `#nav-links` to wrap, and made `#save-settings` `min-width` instead of a fixed width so long labels wrap in a readable way inside a wider button.
- **Console error on /settings.html**: `settings.js` looked for `#save-btn`, w
```

## Containment

Runtime `runsc` · sandbox `ring-2f0ef7f4` · 3g RAM, 2 CPUs, 512 processes · network ring-internal → ring-proxy (allowlist) · destroyed · docker ps -a: gone at 2026-11-03T20:50:09.301Z

## Mantis

Mantis 0.7.1 · baseline run `2026-11-03T20-48-30` · final run `2026-11-03T20-49-55` · compared with the baseline run (R0) · prompt ring-2
