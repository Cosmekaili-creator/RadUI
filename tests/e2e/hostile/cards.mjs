// SPDX-License-Identifier: AGPL-3.0-or-later
// Hostile vCards and collection properties for the `security` suite. Every host is a documentation host
// (example.net, example.org); no payload does anything outside the throwaway stack. Each payload that could run
// script sets window.__xss to its own name, so a hit is visible in the page.
import { vcard } from '../lib/common.mjs';

export const OUTSIDE_HOST = 'attacker.example.net';
export const OUTSIDE_URL = `https://${OUTSIDE_HOST}/pixel.png`;
const b64 = (s) => Buffer.from(s, 'utf8').toString('base64');
const uid = (n) => `urn:uuid:5ec00000-0000-4000-8000-${String(n).padStart(12, '0')}`;

export const SVG = '<svg xmlns="http://www.w3.org/2000/svg" onload="window.__xss=\'svg\'" width="10" height="10"><script>window.__xss=\'svg-script\'</script><rect width="10" height="10" fill="red"/></svg>';

/** A large payload that only looks like a JPEG: 5 MB of bytes behind a JPEG header. */
export function bigPhotoCard() {
  const bytes = Buffer.alloc(5 * 1024 * 1024, 0x41);
  Buffer.from([0xff, 0xd8, 0xff, 0xe0, 0x00, 0x10, 0x4a, 0x46, 0x49, 0x46, 0x00]).copy(bytes);
  return vcard('3.0', ['FN:Big Photo', 'N:Photo;Big;;;', `PHOTO;ENCODING=b;TYPE=JPEG:${bytes.toString('base64')}`], { uid: uid(9) });
}

/** [key, display name, card text]; `fn` is what the detail must show, literally. */
export const CARDS = [
  { key: 'script-fn', fn: "<script>window.__xss='fn-script'</script> Mallory", n: 1, props: ["FN:<script>window.__xss='fn-script'</script> Mallory", "N:Mallory;<img src=x onerror=\"window.__xss='n-img'\">;;;", 'ORG:<b>Bold Org</b>', "NICKNAME:\"><svg/onload=window.__xss='nick'>", 'TITLE:<i>Title</i>'] },
  { key: 'note', fn: 'Note Attack', n: 2, props: ['FN:Note Attack', 'N:Attack;Note;;;', `NOTE:<img src=${OUTSIDE_URL} onerror="window.__xss='note-img'">\\n<a href="javascript:window.__xss='note-link'">click</a>\\n<iframe src="https://${OUTSIDE_HOST}/"></iframe>\\n&lt;script&gt;`] },
  { key: 'urls', fn: 'Url Attack', n: 3, props: ['FN:Url Attack', 'N:Attack;Url;;;', "URL:javascript:window.__xss='url'", 'URL:JaVaScRiPt:window.__xss=1', 'URL:data:text/html\\;base64\\,PHNjcmlwdD53aW5kb3cuX194c3M9MTwvc2NyaXB0Pg==', 'URL:vbscript:msgbox(1)', 'URL:https://user:secret@example.org/with-credentials', 'URL:https://example.org/fine?a=1&b=<x>', 'URL:ftp://example.org/file', 'URL://attacker.example.net/relative'] },
  { key: 'contact-values', fn: 'Value Attack', n: 4, props: ['FN:Value Attack', 'N:Attack;Value;;;', 'EMAIL:a@mail.example.org?subject=x&bcc=evil@example.net', 'EMAIL:"><script>window.__xss=1</script>@example.org', 'EMAIL:ok@example.org', 'TEL:+1 (555) 0100;ext=1<script>', 'TEL:javascript:alert(1)', 'ADR;TYPE=home:;;<script>window.__xss=1</script> Road;Sampletown;;00001;Exampleland'] },
  { key: 'photo-svg', fn: 'Svg Photo', n: 5, props: ['FN:Svg Photo', 'N:Photo;Svg;;;', `PHOTO;ENCODING=b;TYPE=SVG:${b64(SVG)}`] },
  { key: 'photo-svg-data', fn: 'Svg Data Photo', n: 6, version: '4.0', props: ['FN:Svg Data Photo', `PHOTO:data:image/svg+xml;base64,${b64(SVG)}`] },
  { key: 'photo-uri', fn: 'Uri Photo', n: 7, props: ['FN:Uri Photo', 'N:Photo;Uri;;;', `PHOTO;VALUE=uri:${OUTSIDE_URL}`] },
  { key: 'photo-uri4', fn: 'Uri Photo Four', n: 8, version: '4.0', props: ['FN:Uri Photo Four', `PHOTO:${OUTSIDE_URL}`] },
  // valid base64 that is only the first bytes of a JPEG: the header parser and the decoder must refuse it quietly
  { key: 'photo-truncated', fn: 'Truncated Photo', n: 10, props: ['FN:Truncated Photo', 'N:Photo;Truncated;;;', `PHOTO;ENCODING=b;TYPE=JPEG:${Buffer.from([0xff, 0xd8, 0xff, 0xe0, 0x00, 0x10, 0x4a, 0x46, 0x49, 0x46, 0x00, 0x01]).toString('base64')}`] },
  // a PNG signature with a huge declared size (50000 x 50000): refused from the header, never decoded
  { key: 'photo-huge-png', fn: 'Huge Png', n: 13, props: ['FN:Huge Png', 'N:Png;Huge;;;', `PHOTO;ENCODING=b;TYPE=PNG:${Buffer.from('89504e470d0a1a0a0000000d49484452' + '0000c350' + '0000c350' + '0806000000' + '00000000', 'hex').toString('base64')}`] },
  { key: 'photo-html', fn: 'Html Photo', n: 11, props: ['FN:Html Photo', 'N:Photo;Html;;;', `PHOTO;ENCODING=b;TYPE=JPEG:${b64('<html><script>window.__xss="html"</script></html>')}`] },
  { key: 'bidi', fn: 'Bidi ‮evil‬ ⁦x⁩ name', n: 12, props: ['FN:Bidi ‮evil‬ ⁦x⁩ name', 'N:Name;‮Bidi‬;;;', 'NOTE:Line with ‏ right-to-left mark and ⁧ isolate ‮ reversed'] },
];

export function cardText(c) {
  return vcard(c.version || '3.0', c.props, { uid: uid(c.n) });
}
export const cardUid = (c) => uid(c.n);
export const cardFile = (c) => `${c.key}.vcf`;

// -------------------------------------------------------------------------------------------- collections
export const HOSTILE_BOOK = {
  name: "<img src=x onerror=\"window.__xss='book-name'\"> Hostile book",
  desc: `<script>window.__xss='book-desc'</script> <a href="javascript:window.__xss=1">x</a> <img src=${OUTSIDE_URL}>`,
};
export const HOSTILE_CAL = {
  name: '"><svg/onload=window.__xss=\'cal-name\'> Hostile calendar',
  desc: `</p><script>window.__xss='cal-desc'</script>`,
  // not a colour: the application must never write it into a style
  colour: `red;background:url(//${OUTSIDE_HOST}/x)`,
};

/** Text that is not base64 at all: Radicale refuses it (400), so it can only be tested as a refusal. */
export const BAD_BASE64_CARD = vcard('3.0', ['FN:Bad Base64', 'N:Base64;Bad;;;', 'PHOTO;ENCODING=b;TYPE=JPEG:!!!not*base64***='], { uid: uid(14) });
