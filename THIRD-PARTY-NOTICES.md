# Third-party notices

Code that is vendored into this repository, with its licence. Each vendored component keeps
its own licence file next to it.

| Component | Version | Licence | Location | Notes |
|---|---|---|---|---|
| ical.js | 2.2.1 | MPL-2.0 (confirmed: `LICENSE` is the unmodified MPL-2.0 text; every source file carries the MPL header; no other licence bundled) | `src/vendor/ical.js/2.2.1/` | Unmodified `dist/ical.min.js` (ES module, 77 698 bytes, SHA-256 `6643f20634241dc040e02c2f10e3c48cf9bcda4b3180f4321a3d05a3a83dfe52`) plus `LICENSE` (SHA-256 `1f256ecad192880510e84ad60474eab7589218784b9a50bc7ceee34c2b91f1d5`) and `SHA256SUMS`. Source: https://registry.npmjs.org/ical.js/-/ical.js-2.2.1.tgz (npm `dist.integrity` `sha512-yK/UlPbEs316igb/tjRgbFA8ZV75rCsBJp/hWOatpyaPNlgw0dGDmU+FoicOcwX4xXkeXOkYiOmCqNPFpNPkQg==`, shasum `f06fe9b32498d948893ec994e6964379dac6a907`), upstream https://github.com/kewisch/ical.js. MPL-2.0 is file-level copyleft: the vendored file stays unmodified and its source is available at the URL above. |

Runtime dependencies that are installed but not vendored (Radicale, bcrypt) are not listed here.
