<!-- SPDX-License-Identifier: AGPL-3.0-or-later -->
# Icons

Original artwork: a ring (the cycle of days) with one dot cut into it (a scheduled moment).
No third-party artwork.

| File | Use |
|---|---|
| `radui.svg` | Master mark on a 64-unit grid (edit this one). Also used as the page logo. |
| `favicon.svg`, `favicon.ico` | Browser tab icon (SVG, plus 16/32/48 px ICO). |
| `icon-192.png`, `icon-512.png` | Manifest icons, purpose `any`. |
| `icon-maskable.svg`, `icon-maskable-512.png` | Full-bleed background, artwork inside the 80 % safe zone. |
| `icon-touch.svg`, `apple-touch-icon-180.png` | iOS home-screen icon. |
| `icon-mono.svg` | One-colour mark on a transparent background. |
| `radui-wordmark.svg` | Mark and name lockup. |

Colours: accent `#1E5E52`, foreground `#F4F7F5` (same as `--logo-bg` and `--logo-fg` in
`css/tokens.css`). PNG and ICO files are rasterised from the SVG sources with any SVG renderer;
check 16 px legibility, the maskable crop and the 96 px touch icon after each export.
