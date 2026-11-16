// SPDX-License-Identifier: AGPL-3.0-or-later
import test from "node:test";
import assert from "node:assert/strict";
import { openItem } from "../../../src/js/model/item.js";
import { DISPLAY_LIMITS, PhotoError, UPLOAD_LIMITS, bytesToBase64, canDisplayPhoto, imageInfo, processPhoto, sniffType } from "../../../src/js/contacts/photo.js";

// -- header builders ---------------------------------------------------------------------------------------

const be16 = (n) => [(n >> 8) & 255, n & 255];
const be32 = (n) => [(n >>> 24) & 255, (n >>> 16) & 255, (n >>> 8) & 255, n & 255];
const le16 = (n) => [n & 255, (n >> 8) & 255];
const asc = (s) => [...s].map((c) => c.charCodeAt(0));
const pad = (a, n = 64) => Uint8Array.from([...a, ...new Array(Math.max(0, n - a.length)).fill(0)]);

const jpeg = (w, h, { sof = 0xc0, exif = 0 } = {}) =>
  pad([0xff, 0xd8, 0xff, 0xe0, ...be16(16), ...asc("JFIF"), 0, 1, 1, 0, 0, 1, 0, 1, 0, 0, ...(exif ? [0xff, 0xe1, ...be16(exif + 2), ...new Array(exif).fill(7)] : []), 0xff, 0xc4, ...be16(4), 0, 0, 0xff, sof, ...be16(17), 8, ...be16(h), ...be16(w), 3, 1, 0x22, 0, 2, 0x11, 1, 3, 0x11, 1]);
const png = (w, h) => pad([0x89, ...asc("PNG"), 0x0d, 0x0a, 0x1a, 0x0a, ...be32(13), ...asc("IHDR"), ...be32(w), ...be32(h), 8, 6, 0, 0, 0]);
const gif = (w, h, v = "GIF89a") => pad([...asc(v), ...le16(w), ...le16(h), 0, 0, 0]);
const webpLossy = (w, h) => pad([...asc("RIFF"), 0, 0, 0, 0, ...asc("WEBP"), ...asc("VP8 "), 0, 0, 0, 0, 0, 0, 0, 0x9d, 0x01, 0x2a, ...le16(w), ...le16(h)]);
const webpLossless = (w, h) => {
  const bits = (w - 1) | ((h - 1) << 14);
  return pad([...asc("RIFF"), 0, 0, 0, 0, ...asc("WEBP"), ...asc("VP8L"), 0, 0, 0, 0, 0x2f, bits & 255, (bits >>> 8) & 255, (bits >>> 16) & 255, (bits >>> 24) & 255]);
};
const webpExt = (w, h) => pad([...asc("RIFF"), 0, 0, 0, 0, ...asc("WEBP"), ...asc("VP8X"), 10, 0, 0, 0, 0, 0, 0, 0, (w - 1) & 255, ((w - 1) >> 8) & 255, ((w - 1) >> 16) & 255, (h - 1) & 255, ((h - 1) >> 8) & 255, ((h - 1) >> 16) & 255]);

test("imageInfo: size and type from the header of every format", () => {
  assert.deepEqual(imageInfo(jpeg(4000, 3000)), { ok: true, type: "jpeg", mime: "image/jpeg", width: 4000, height: 3000 });
  assert.deepEqual(imageInfo(jpeg(640, 480, { sof: 0xc2 })), { ok: true, type: "jpeg", mime: "image/jpeg", width: 640, height: 480 });
  assert.equal(imageInfo(jpeg(100, 50, { exif: 3000 })).width, 100, "a large EXIF segment is skipped");
  assert.deepEqual(imageInfo(png(30000, 30000)), { ok: true, type: "png", mime: "image/png", width: 30000, height: 30000 });
  assert.deepEqual(imageInfo(gif(320, 200)), { ok: true, type: "gif", mime: "image/gif", width: 320, height: 200 });
  assert.equal(imageInfo(gif(5, 6, "GIF87a")).width, 5);
  assert.deepEqual(imageInfo(webpLossy(800, 600)), { ok: true, type: "webp", mime: "image/webp", width: 800, height: 600 });
  assert.deepEqual(imageInfo(webpLossless(1024, 768)), { ok: true, type: "webp", mime: "image/webp", width: 1024, height: 768 });
  assert.deepEqual(imageInfo(webpExt(5000, 4000)), { ok: true, type: "webp", mime: "image/webp", width: 5000, height: 4000 });
});

test("imageInfo: refuses what is not an image or has no readable size", () => {
  assert.deepEqual(imageInfo(new Uint8Array(0)), { ok: false, reason: "unknown-format" });
  assert.equal(imageInfo(Uint8Array.from(asc('<svg xmlns="http://www.w3.org/2000/svg"/>'))).reason, "unknown-format");
  assert.equal(imageInfo(Uint8Array.from(asc("%PDF-1.4"))).reason, "unknown-format");
  assert.equal(imageInfo(Uint8Array.from([0xff, 0xd8, 0xff])).reason, "bad-header", "truncated JPEG");
  assert.equal(imageInfo(png(0, 10)).reason, "bad-header");
  assert.equal(imageInfo(png(10, 0)).reason, "bad-header");
  assert.equal(imageInfo(Uint8Array.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a])).reason, "bad-header");
  assert.equal(imageInfo(webpLossy(0, 0)).reason, "bad-header");
  assert.equal(imageInfo(pad([0xff, 0xd8, 0xff, 0xda, ...be16(4), 0, 0])).reason, "bad-header", "scan before any frame header");
  assert.equal(imageInfo(pad([0xff, 0xd8, 0xff, 0xe0, 0, 1])).reason, "bad-header", "bad segment length");
  assert.equal(sniffType(Uint8Array.from(asc("RIFF....WAVE"))), null);
  assert.equal(imageInfo(jpeg(1, 1).subarray(0, 12)).ok, false);
});

// -- fakes -------------------------------------------------------------------------------------------------------

function fakeFile(head, { type, size } = {}) {
  const bytes = head instanceof Uint8Array ? head : Uint8Array.from(head);
  return {
    type,
    size: size ?? bytes.length,
    slice: (a, b) => ({ arrayBuffer: async () => bytes.slice(a, b).buffer }),
  };
}

function fakeApi({ bitmap = { width: 256, height: 192 }, sizes = { 0.85: 9000, 0.7: 7000 }, bitmapFails = 0, useToBlob = false, jpegOut = true } = {}) {
  const log = { bitmapCalls: [], canvases: [], encodes: [], closed: 0 };
  let failsLeft = bitmapFails;
  const mkBlob = (n) => ({ arrayBuffer: async () => Uint8Array.from([...(jpegOut ? [0xff, 0xd8, 0xff, 0xe0] : [0x89, 0x50, 0x4e, 0x47]), ...new Array(n - 4).fill(1)]).buffer });
  return {
    log,
    createImageBitmap: async (file, options) => {
      log.bitmapCalls.push(options);
      if (failsLeft > 0) {
        failsLeft--;
        throw new TypeError("unsupported options");
      }
      return { ...bitmap, close: () => log.closed++ };
    },
    createCanvas: (w, h) => {
      const ctx = { ops: [], set fillStyle(v) { this.ops.push(["fillStyle", v]); }, fillRect: (...a) => ctx.ops.push(["fillRect", ...a]), drawImage: (_b, ...a) => ctx.ops.push(["drawImage", ...a]) };
      const canvas = { w, h, ctx, getContext: (t) => (t === "2d" ? ctx : null) };
      const enc = (type, q) => {
        log.encodes.push([type, q]);
        return mkBlob(sizes[q] ?? 5000);
      };
      if (useToBlob) canvas.toBlob = (cb, type, q) => cb(enc(type, q));
      else canvas.convertToBlob = async ({ type, quality }) => enc(type, quality);
      log.canvases.push(canvas);
      return canvas;
    },
  };
}

const reason = async (p) => {
  try {
    await p;
  } catch (e) {
    assert.ok(e instanceof PhotoError, String(e));
    assert.equal(e.key, `photo.err.${e.code}`);
    return e.code;
  }
  return "accepted";
};

// -- upload ---------------------------------------------------------------------------------------------------------

test("a landscape JPEG is resized on decode (one resize parameter), drawn on white, encoded at 0.85", async () => {
  const api = fakeApi({ bitmap: { width: 256, height: 192 } });
  const r = await processPhoto(fakeFile(jpeg(4000, 3000), { type: "image/jpeg" }), api);
  assert.deepEqual(api.log.bitmapCalls, [{ imageOrientation: "from-image", resizeWidth: 256 }]);
  assert.equal(r.mime, "image/jpeg");
  assert.deepEqual([r.width, r.height, r.quality, r.bytes], [256, 192, 0.85, 9000]);
  const bytes = Buffer.from(r.base64, "base64");
  assert.equal(bytes.length, 9000);
  assert.deepEqual([...bytes.subarray(0, 3)], [0xff, 0xd8, 0xff]);
  assert.match(r.base64, /^[A-Za-z0-9+/]+=*$/);
  const [c] = api.log.canvases;
  assert.deepEqual([c.w, c.h], [256, 192]);
  assert.deepEqual(c.ctx.ops, [["fillStyle", "#ffffff"], ["fillRect", 0, 0, 256, 192], ["drawImage", 0, 0, 256, 192]], "white background first");
  assert.deepEqual(api.log.encodes, [["image/jpeg", 0.85]]);
  assert.equal(api.log.closed, 1, "the bitmap is released");
});

test("a portrait image resizes the height; a small image is not resized or enlarged", async () => {
  const p = fakeApi({ bitmap: { width: 192, height: 256 } });
  await processPhoto(fakeFile(png(3000, 4000), { type: "image/png" }), p);
  assert.deepEqual(p.log.bitmapCalls, [{ imageOrientation: "from-image", resizeHeight: 256 }]);
  const s = fakeApi({ bitmap: { width: 100, height: 80 } });
  const r = await processPhoto(fakeFile(gif(100, 80), { type: "image/gif" }), s);
  assert.deepEqual(s.log.bitmapCalls, [{ imageOrientation: "from-image" }]);
  assert.deepEqual([r.width, r.height], [100, 80]);
});

test("the decoded size, not the header, sets the canvas: a bitmap larger than 256 is scaled down (EXIF-rotated resize order)", async () => {
  const api = fakeApi({ bitmap: { width: 341, height: 256 } });
  const r = await processPhoto(fakeFile(jpeg(3000, 4000), { type: "image/jpeg" }), api);
  assert.ok(Math.max(r.width, r.height) <= 256);
  assert.deepEqual([r.width, r.height], [256, 192]);
  const big = fakeApi({ bitmap: { width: 4000, height: 3000 } }); // a decoder that ignored the resize
  const r2 = await processPhoto(fakeFile(jpeg(4000, 3000), { type: "image/jpeg" }), big);
  assert.deepEqual([r2.width, r2.height], [256, 192]);
});

test("WebP and GIF inputs are accepted by type and magic bytes", async () => {
  for (const [bytes, type] of [[webpLossy(500, 500), "image/webp"], [webpLossless(500, 500), "image/webp"], [webpExt(500, 500), "image/webp"], [gif(500, 500), "image/gif"]]) {
    assert.equal((await processPhoto(fakeFile(bytes, { type }), fakeApi())).mime, "image/jpeg");
  }
});

test("quality: 0.85 first, 0.7 when the result is over 48 KB, no second encode when small", async () => {
  const big = fakeApi({ sizes: { 0.85: 60000, 0.7: 40000 } });
  const r = await processPhoto(fakeFile(jpeg(1000, 1000), { type: "image/jpeg" }), big);
  assert.deepEqual(big.log.encodes, [["image/jpeg", 0.85], ["image/jpeg", 0.7]]);
  assert.deepEqual([r.quality, r.bytes], [0.7, 40000]);
  const edge = fakeApi({ sizes: { 0.85: 48 * 1024 } });
  await processPhoto(fakeFile(jpeg(1000, 1000), { type: "image/jpeg" }), edge);
  assert.equal(edge.log.encodes.length, 1, "exactly 48 KB stays");
  const tb = fakeApi({ useToBlob: true });
  assert.equal((await processPhoto(fakeFile(jpeg(1000, 1000), { type: "image/jpeg" }), tb)).mime, "image/jpeg", "canvas.toBlob works as well");
});

test("decode fallback: options refused -> full decode; both refused -> decode-failed", async () => {
  const api = fakeApi({ bitmapFails: 1 });
  await processPhoto(fakeFile(jpeg(2000, 1000), { type: "image/jpeg" }), api);
  assert.equal(api.log.bitmapCalls.length, 2);
  assert.equal(api.log.bitmapCalls[1], undefined, "second call has no options");
  assert.equal(await reason(processPhoto(fakeFile(jpeg(2000, 1000), { type: "image/jpeg" }), fakeApi({ bitmapFails: 2 }))), "decode-failed");
});

test("rejections before any decoding: empty, too big, type, magic bytes, pixels", async () => {
  const never = fakeApi();
  const okHead = jpeg(100, 100);
  assert.equal(await reason(processPhoto(null, never)), "not-a-file");
  assert.equal(await reason(processPhoto(fakeFile([], { type: "image/jpeg" }), never)), "empty");
  assert.equal(await reason(processPhoto(fakeFile(okHead, { type: "image/jpeg", size: UPLOAD_LIMITS.bytes + 1 }), never)), "too-large");
  assert.equal(await reason(processPhoto(fakeFile(okHead, { type: "image/jpeg", size: UPLOAD_LIMITS.bytes }), fakeApi())), "accepted", "exactly 15 MB is allowed");
  for (const type of ["image/svg+xml", "image/bmp", "image/tiff", "application/pdf", "", "text/plain", "image/heic"]) {
    assert.equal(await reason(processPhoto(fakeFile(okHead, { type }), never)), "unsupported-type", type);
  }
  assert.equal(await reason(processPhoto(fakeFile(png(10, 10), { type: "image/jpeg" }), never)), "type-mismatch");
  assert.equal(await reason(processPhoto(fakeFile(okHead, { type: "image/png" }), never)), "type-mismatch");
  assert.equal(await reason(processPhoto(fakeFile(asc('<svg onload="alert(1)"/>'), { type: "image/png" }), never)), "unsupported-type", "an SVG under a PNG label");
  assert.equal(await reason(processPhoto(fakeFile(asc("GIF89"), { type: "image/gif" }), never)), "unsupported-type");
  assert.equal(await reason(processPhoto(fakeFile(png(0, 0), { type: "image/png" }), never)), "bad-image");
  assert.equal(await reason(processPhoto(fakeFile(png(6000, 4001), { type: "image/png" }), never)), "too-many-pixels", "24.006 MP");
  assert.equal(await reason(processPhoto(fakeFile(png(30000, 30000), { type: "image/png" }), never)), "too-many-pixels");
  assert.equal(await reason(processPhoto(fakeFile(png(6000, 4000), { type: "image/png" }), fakeApi())), "accepted", "exactly 24 MP is allowed");
  assert.equal(never.log.bitmapCalls.length, 0, "nothing was decoded for a refused file");
  assert.equal(UPLOAD_LIMITS.pixels, 24e6);
});

test("encoder returning something that is not a JPEG is refused", async () => {
  assert.equal(await reason(processPhoto(fakeFile(jpeg(100, 100), { type: "image/jpeg" }), fakeApi({ jpegOut: false }))), "encode-failed");
  const noBlob = fakeApi();
  const orig = noBlob.createCanvas;
  noBlob.createCanvas = (w, h) => {
    const c = orig(w, h);
    c.convertToBlob = async () => null;
    return c;
  };
  assert.equal(await reason(processPhoto(fakeFile(jpeg(100, 100), { type: "image/jpeg" }), noBlob)), "encode-failed");
});

test("the bitmap is closed even when encoding fails; no blob: URL is used", async () => {
  const api = fakeApi({ jpegOut: false });
  await reason(processPhoto(fakeFile(jpeg(100, 100), { type: "image/jpeg" }), api));
  assert.equal(api.log.closed, 1);
  assert.ok(!/URL\.createObjectURL|blob:/.test(String(processPhoto)));
});

test("bytesToBase64 handles large buffers", () => {
  const big = new Uint8Array(200000).map((_, i) => i % 251);
  assert.equal(bytesToBase64(big), Buffer.from(big).toString("base64"));
  assert.equal(bytesToBase64(new Uint8Array(0)), "");
});

// -- display of an existing photo -----------------------------------------------------------------------------------------

const cardWith = (photoLines) => openItem(`BEGIN:VCARD\nVERSION:3.0\nUID:p1\nFN:P\n${photoLines}\nEND:VCARD\n`, "contact");
const b64 = (bytes) => Buffer.from(bytes).toString("base64");
const shown = (bytes, params = "ENCODING=b;TYPE=JPEG") => canDisplayPhoto(cardWith(`PHOTO;${params}:${b64(bytes)}`));

test("canDisplayPhoto: whitelisted images within the limits are drawn, with the real MIME type", () => {
  const r = shown(jpeg(300, 200));
  assert.deepEqual([r.ok, r.mime, r.width, r.height], [true, "image/jpeg", 300, 200]);
  assert.equal(r.base64, b64(jpeg(300, 200)));
  assert.equal(shown(png(4096, 3900), "ENCODING=b;TYPE=PNG").ok, true, "4096 px is allowed");
  assert.equal(shown(png(4000, 4000), "ENCODING=b;TYPE=PNG").ok, true, "16 MP exactly");
  assert.equal(shown(webpLossy(800, 600), "ENCODING=b;MEDIATYPE=image/webp").mime, "image/webp");
  assert.equal(canDisplayPhoto(cardWith(`PHOTO:data:image/gif;base64,${b64(gif(10, 10))}`)).mime, "image/gif");
  assert.equal(shown(png(50, 50), "ENCODING=b;TYPE=JPEG").mime, "image/png", "the bytes decide, not the label");
  assert.equal(canDisplayPhoto(cardWith(`PHOTO;ENCODING=b:${b64(jpeg(20, 20))}`)).mime, "image/jpeg", "no declared type: sniffed");
  assert.equal(canDisplayPhoto(cardWith(`PHOTO;ENCODING=b;TYPE=JPEG:${b64(jpeg(20, 20, { exif: 3000 })).replace(/(.{76})/g, "$1\n ")}`)).ok, true, "folded base64");
  const item = cardWith(`PHOTO;ENCODING=b;TYPE=JPEG:${b64(jpeg(20, 20))}`);
  assert.equal(canDisplayPhoto(item.main).ok, true, "an Item or its component");
});

test("canDisplayPhoto: refusals give initials and a reason key (never SVG, no decompression bombs)", () => {
  const key = (r) => [r.ok, r.reason, r.key];
  assert.deepEqual(key(canDisplayPhoto(cardWith(""))), [false, "none", "photo.note.none"]);
  assert.deepEqual(key(shown(png(30000, 30000), "ENCODING=b;TYPE=PNG")), [false, "too-wide", "photo.note.too-wide"]);
  assert.equal(shown(jpeg(4097, 100)).reason, "too-wide");
  assert.equal(shown(jpeg(100, 4097)).reason, "too-wide");
  assert.equal(shown(png(4096, 4096), "ENCODING=b;TYPE=PNG").reason, "too-many-pixels", "16.7 MP");
  assert.equal(shown(Uint8Array.from(asc('<svg xmlns="http://www.w3.org/2000/svg"><script>alert(1)</script></svg>'))).reason, "bad-image", "SVG bytes under a JPEG label");
  assert.equal(canDisplayPhoto(cardWith(`PHOTO;ENCODING=b;TYPE=SVG:${b64(asc("<svg/>"))}`)).reason, "unsupported-mime");
  assert.equal(canDisplayPhoto(cardWith(`PHOTO:data:image/svg+xml;base64,${b64(asc("<svg/>"))}`)).reason, "unsupported-mime");
  assert.equal(canDisplayPhoto(cardWith("PHOTO;VALUE=uri:https://example.org/a.jpg")).reason, "external-uri");
  assert.equal(canDisplayPhoto(cardWith("PHOTO;ENCODING=b;TYPE=JPEG:@@@@")).reason, "bad-base64");
  assert.equal(canDisplayPhoto(cardWith("PHOTO:data:image/png,%89PNG")).reason, "not-base64");
  assert.equal(shown(jpeg(10, 10).subarray(0, 8)).reason, "bad-image", "truncated header");
  const huge = new Uint8Array(DISPLAY_LIMITS.bytes + 3);
  huge.set(jpeg(10, 10));
  assert.equal(shown(huge).reason, "too-large");
  const edge = new Uint8Array(DISPLAY_LIMITS.bytes);
  edge.set(jpeg(10, 10));
  assert.equal(shown(edge).ok, true, "exactly 1.5 MB is allowed");
  assert.equal(canDisplayPhoto(null).ok, false);
});

test("canDisplayPhoto works on the corpus photo fixtures without throwing", async () => {
  const { fixtures } = await import("../model/helpers.mjs");
  for (const f of fixtures().filter((x) => /photo/.test(x.file))) {
    const item = openItem(f.text, "contact");
    if (!item.ok) continue;
    const r = canDisplayPhoto(item);
    assert.equal(typeof r.ok, "boolean", f.name);
    if (!r.ok) assert.ok(r.key.startsWith("photo.note."), f.name);
  }
});
