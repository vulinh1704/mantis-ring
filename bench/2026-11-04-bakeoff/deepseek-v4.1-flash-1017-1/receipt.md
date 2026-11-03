# Mantis Ring receipt · t_85427a26b9ba0243ffc7841bdf58fd66

REAL RUN · Vultr VX1 sea · 2026-11-03 20:46 UTC

**18 fixed · 0 new · 0 cover-ups · 0 lost**

Final run re-measured by Mantis (no LLM) and compared with the baseline run R0.

- Verdict: **pass** · publishable: yes · stop reason: finish
- Source: sample `lumen`
- Matrix: 16 screens · routes `/`, `/settings.html` · mobile, desktop · light, dark · en, vi
- Started 2026-11-03T20:46:25.048Z · finished 2026-11-03T20:48:07.441Z

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
| 1 | accepted | 14 fixed · 0 new · 0 cover-ups · 0 lost | 9.9 | forced |
| 2 | accepted | 18 fixed · 0 new · 0 cover-ups · 0 lost | 10 | — |

## Models

| Role | Model | Provider | Calls | Prompt | Completion | Reasoning | Cost (list price) |
|---|---|---|---|---|---|---|---|
| fix | `deepseek-v4.1-flash-1017` | Vultr Serverless Inference | 28 | 359195 | 13401 | 9539 | $0.0619 |

Total: 359195 prompt + 13401 completion tokens (9539 reasoning) · $0.0619 · 28 turns · 44 tool calls (0 invalid, 0 errors)
- `deepseek-v4.1-flash-1017`: $0.15 in / $0.6 out per 1M tokens (catalog list price, 2026-11-03)

## Time

Total 102.4 s · sandbox 0.1 s · clone 0.4 s · serve 0.2 s · baseline 12.6 s · model 63.5 s · tools 3.4 s · checks 19.9 s · verify 0.2 s · proof 1.8 s · copyOut 0.1 s · destroy 0.1 s

## Diff

3 file(s), +23 −22, 6725 bytes · sha256 `c9478fcb3fdfc44c6d5066454e8aab5ccff75a6a43c74769678e2bffeb65dafc` · applies to the original: yes

## Vision second opinion

Skipped.

## The model's summary

The model's own words, not measured.

```text
Fixed all 18 issues (14 errors + 4 warnings) with no new problems introduced.

What I changed:
- Promo banner: `width: 600px` → `width: 100%; max-width: 600px`, so it no longer overflows mobile viewports.
- Nav links: replaced the `max-width: 420px; overflow: hidden; white-space: nowrap` clipping with `flex-wrap: wrap`, so long Vietnamese labels ("Câu hỏi thường gặp") stay fully visible on desktop.
- Header on mobile: removed the absolute-positioned `.menu-toggle` rule that made it overlap the header CTA, and tightened the header gap.
- Popular badge: removed the mobile rule that pushed `.badge` down onto the plan CTA text.
- Hero note: swapped hard-coded `#aaa` for the `--muted` token (fixes light-mode contrast).
- Business plan card: replaced hard-coded `background: #fff` with `var(--surface)`, which fixes the dark-mode theme leak and the three contrast failures on its name/amount/per text.
- Newsletter button: `width: 120px` → `min-width: 120px` and dropped `overflow: hidden`, so the Vietnamese label isn't cut off.
- Settings save button: `width: 84px` → `min-width: 84px`, letting "Lưu tất cả thay đổi" fit instead of wrapping to 4 lines.
- Danger zone title: hard-coded `#7f1d1d` → `var(--danger-ink)` token (contrast + theme leak in dark mode).
- Hero art: added `aspect-ratio: 16 / 9` to reserve space and remove the 0.161 layout shift.
- Social links: 16×16px icons → 32×32px tap targets with real spacing.
- Team photo: pointed `src` at the existing `/img/team.svg` instead o
```

## Containment

Runtime `runsc` · sandbox `ring-626c6156` · 3g RAM, 2 CPUs, 512 processes · network ring-internal → ring-proxy (allowlist) · destroyed · docker ps -a: gone at 2026-11-03T20:48:07.440Z

## Mantis

Mantis 0.7.1 · baseline run `2026-11-03T20-46-25` · final run `2026-11-03T20-47-43` · compared with the baseline run (R0) · prompt ring-2
