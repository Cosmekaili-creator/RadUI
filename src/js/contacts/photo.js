// SPDX-License-Identifier: AGPL-3.0-or-later
// Contact photos (RUN2 D-R2-11, addendum M6). Pure logic: the browser image APIs are passed in
// (`api`), so everything runs in Node tests with fakes.
//
//   processPhoto(file, api)   an uploaded file -> {mime: 'image/jpeg', base64, ...} (<= 256 px)
//   canDisplayPhoto(card)     may an EXISTING photo be drawn? else initials + a reason key
//   imageInfo(bytes)          format and pixel size read from the header, without decoding
//
// Uploads: JPEG, PNG, WebP or GIF by MIME type AND magic bytes (they must agree), at most 15 MB
// and 24 megapixels (read from the header BEFORE any decode). The image is re-encoded on a white
// canvas, longest side <= 256 px, JPEG 0.85 (0.7 when over 48 KB): EXIF (GPS included) is gone.
// The result is base64 made from bytes; no blob: URL is ever created.
// Display: whitelisted type (never SVG), valid base64, payload <= 1.5 MB, <= 16 MP and <= 4096 px
// per side, judged from the header; otherwise the caller shows the initials and a note.

import { MAX_PHOTO_PAYLOAD, PHOTO_MIMES, readPhotoData } from "../model/vcard.js";

export const UPLOAD_LIMITS = Object.freeze({ bytes: 15 * 1024 * 1024, pixels: 24e6 });
export const DISPLAY_LIMITS = Object.freeze({ bytes: MAX_PHOTO_PAYLOAD, pixels: 16e6, side: 4096 });
export const OUTPUT = Object.freeze({ side: 256, quality: 0.85, fallbackQuality: 0.7, softBytes: 48 * 1024 });
/** Bytes read from the start of a file/payload to find the image size. */
export const HEADER_WINDOW = 512 * 1024;
export const ACCEPT = PHOTO_MIMES.join(",");

export class PhotoError extends Error {
  constructor(code, params = {}) {
    super(`photo refused (${code})`);
    this.name = "PhotoError";
    this.code = code;
    /** Message key for the dictionaries. */
    this.key = `photo.err.${code}`;
    this.params = params;
  }
}

// ---------------------------------------------------------------------------
// Header parsing

const u16be = (b, i) => (b[i] << 8) | b[i + 1];
const u16le = (b, i) => b[i] | (b[i + 1] << 8);
const u32be = (b, i) => ((b[i] << 24) | (b[i + 1] << 16) | (b[i + 2] << 8) | b[i + 3]) >>> 0;
const ascii = (b, i, n) => String.fromCharCode(...b.subarray(i, i + n));

/** 'jpeg' | 'png' | 'gif' | 'webp' | null from the first bytes. */
export function sniffType(b) {
  if (b.length >= 3 && b[0] === 0xff && b[1] === 0xd8 && b[2] === 0xff) return "jpeg";
  if (b.length >= 8 && b[0] === 0x89 && ascii(b, 1, 3) === "PNG" && b[4] === 0x0d && b[5] === 0x0a && b[6] === 0x1a && b[7] === 0x0a) return "png";
  if (b.length >= 6 && (ascii(b, 0, 6) === "GIF87a" || ascii(b, 0, 6) === "GIF89a")) return "gif";
  if (b.length >= 12 && ascii(b, 0, 4) === "RIFF" && ascii(b, 8, 4) === "WEBP") return "webp";
  return null;
}

const MIME_OF = { jpeg: "image/jpeg", png: "image/png", gif: "image/gif", webp: "image/webp" };

function jpegSize(b) {
  let i = 2;
  while (i + 3 < b.length) {
    if (b[i] !== 0xff) return null; // lost sync
    let m = b[i + 1];
    while (m === 0xff && i + 2 < b.length) {
      i++;
      m = b[i + 1];
    }
    i += 2;
    if (m === 0xd8 || m === 0x01 || (m >= 0xd0 && m <= 0xd7)) continue; // no length
    if (m === 0xd9 || m === 0xda) return null; // end of image / scan before any frame header
    if (i + 1 >= b.length) return null;
    const len = u16be(b, i);
    if (len < 2) return null;
    if (m >= 0xc0 && m <= 0xcf && m !== 0xc4 && m !== 0xc8 && m !== 0xcc) {
      if (i + 7 > b.length) return null;
      return { height: u16be(b, i + 3), width: u16be(b, i + 5) };
    }
    i += len;
  }
  return null;
}

function pngSize(b) {
  if (b.length < 24 || u32be(b, 8) !== 13 || ascii(b, 12, 4) !== "IHDR") return null;
  return { width: u32be(b, 16), height: u32be(b, 20) };
}

function gifSize(b) {
  return b.length >= 10 ? { width: u16le(b, 6), height: u16le(b, 8) } : null;
}

function webpSize(b) {
  if (b.length < 30) return null;
  const kind = ascii(b, 12, 4);
  if (kind === "VP8 ") {
    if (b[23] !== 0x9d || b[24] !== 0x01 || b[25] !== 0x2a) return null;
    return { width: u16le(b, 26) & 0x3fff, height: u16le(b, 28) & 0x3fff };
  }
  if (kind === "VP8L") {
    if (b[20] !== 0x2f) return null;
    const bits = b[21] | (b[22] << 8) | (b[23] << 16) | (b[24] << 24);
    return { width: (bits & 0x3fff) + 1, height: ((bits >>> 14) & 0x3fff) + 1 };
  }
  if (kind === "VP8X") {
    return { width: 1 + (b[24] | (b[25] << 8) | (b[26] << 16)), height: 1 + (b[27] | (b[28] << 8) | (b[29] << 16)) };
  }
  return null;
}

/**
 * Format and pixel size from the header bytes, without decoding.
 * {ok:true, type, mime, width, height} or {ok:false, reason: 'unknown-format' | 'bad-header'}.
 */
export function imageInfo(bytes) {
  const b = bytes instanceof Uint8Array ? bytes : new Uint8Array(bytes);
  const type = sniffType(b);
  if (!type) return { ok: false, reason: "unknown-format" };
  const size = { jpeg: jpegSize, png: pngSize, gif: gifSize, webp: webpSize }[type](b);
  if (!size || !(size.width > 0) || !(size.height > 0)) return { ok: false, reason: "bad-header", type };
  return { ok: true, type, mime: MIME_OF[type], width: size.width, height: size.height };
}

// ---------------------------------------------------------------------------
// base64 (from bytes; no blob: URL, no FileReader data: URL)

export function bytesToBase64(bytes) {
  let s = "";
  for (let i = 0; i < bytes.length; i += 0x8000) s += String.fromCharCode(...bytes.subarray(i, i + 0x8000));
  return btoa(s);
}

function base64Prefix(b64, maxBytes) {
  const chars = Math.min(b64.length, Math.ceil(maxBytes / 3) * 4);
  const cut = chars - (chars % 4);
  const bin = atob(b64.slice(0, cut));
  const out = new Uint8Array(bin.length);
  for (let i = 0; i < bin.length; i++) out[i] = bin.charCodeAt(i);
  return out;
}

// ---------------------------------------------------------------------------
// Upload

const readBytes = async (api, blob) => {
  if (api && typeof api.readBytes === "function") return new Uint8Array(await api.readBytes(blob));
  return new Uint8Array(await blob.arrayBuffer());
};

async function encodeJpeg(api, canvas, quality) {
  let blob;
  if (typeof canvas.convertToBlob === "function") blob = await canvas.convertToBlob({ type: "image/jpeg", quality });
  else if (typeof canvas.toBlob === "function") blob = await new Promise((resolve) => canvas.toBlob(resolve, "image/jpeg", quality));
  if (!blob) throw new PhotoError("encode-failed");
  const bytes = await readBytes(api, blob);
  if (sniffType(bytes) !== "jpeg") throw new PhotoError("encode-failed");
  return bytes;
}

/**
 * Turn a chosen image file into the photo to store.
 *
 * `api` (browser objects, injected): `createImageBitmap(blob, options?)`, `createCanvas(w, h)`
 * (an OffscreenCanvas or an element: `getContext('2d')`, and `convertToBlob({type, quality})`
 * or `toBlob(cb, type, quality)`), and optionally `readBytes(blob) -> ArrayBuffer`.
 * Resolves to {mime: 'image/jpeg', base64, bytes, width, height, quality}; rejects with a
 * PhotoError whose `key` is a dictionary key (photo.err.<code>).
 */
export async function processPhoto(file, api) {
  if (!file || typeof file.size !== "number") throw new PhotoError("not-a-file");
  if (file.size === 0) throw new PhotoError("empty");
  if (file.size > UPLOAD_LIMITS.bytes) throw new PhotoError("too-large", { max: UPLOAD_LIMITS.bytes });
  const declared = String(file.type || "").toLowerCase();
  if (!PHOTO_MIMES.includes(declared)) throw new PhotoError("unsupported-type");

  const head = await readBytes(api, file.slice(0, Math.min(file.size, HEADER_WINDOW)));
  const info = imageInfo(head);
  if (!info.ok) throw new PhotoError(info.reason === "unknown-format" ? "unsupported-type" : "bad-image");
  if (info.mime !== declared) throw new PhotoError("type-mismatch");
  if (info.width * info.height > UPLOAD_LIMITS.pixels) throw new PhotoError("too-many-pixels", { max: UPLOAD_LIMITS.pixels, width: info.width, height: info.height });

  const longest = Math.max(info.width, info.height);
  let bitmap;
  try {
    // One resize parameter keeps the aspect ratio; the exact size is settled on the canvas below.
    const options = { imageOrientation: "from-image" };
    if (longest > OUTPUT.side) options[info.width >= info.height ? "resizeWidth" : "resizeHeight"] = OUTPUT.side;
    bitmap = await api.createImageBitmap(file, options);
  } catch {
    try {
      bitmap = await api.createImageBitmap(file); // no options support: full decode (the pixel limit was checked above)
    } catch {
      throw new PhotoError("decode-failed");
    }
  }
  try {
    const bw = bitmap.width;
    const bh = bitmap.height;
    if (!(bw > 0) || !(bh > 0)) throw new PhotoError("decode-failed");
    const scale = Math.min(1, OUTPUT.side / Math.max(bw, bh));
    const w = Math.max(1, Math.round(bw * scale));
    const h = Math.max(1, Math.round(bh * scale));
    const canvas = api.createCanvas(w, h);
    const ctx = canvas.getContext("2d");
    if (!ctx) throw new PhotoError("encode-failed");
    ctx.fillStyle = "#ffffff";
    ctx.fillRect(0, 0, w, h);
    ctx.drawImage(bitmap, 0, 0, w, h);
    let quality = OUTPUT.quality;
    let bytes = await encodeJpeg(api, canvas, quality);
    if (bytes.length > OUTPUT.softBytes) {
      quality = OUTPUT.fallbackQuality;
      bytes = await encodeJpeg(api, canvas, quality);
    }
    return { mime: "image/jpeg", base64: bytesToBase64(bytes), bytes: bytes.length, width: w, height: h, quality };
  } finally {
    if (typeof bitmap.close === "function") bitmap.close();
  }
}

// ---------------------------------------------------------------------------
// Display of an existing photo

/**
 * May the photo of this card be drawn? `card` is an Item or its VCARD component.
 * {ok:true, mime, base64, width, height} (the MIME is the one the bytes really have), or
 * {ok:false, reason, key} with reason: none | external-uri | not-base64 | bad-base64 |
 * unsupported-mime | too-large | bad-image | too-many-pixels | too-wide (key `photo.note.<reason>`
 * explains the initials avatar; 'none' needs no note).
 */
export function canDisplayPhoto(card) {
  const comp = card && card.main ? card.main : card;
  const fail = (reason) => ({ ok: false, reason, key: `photo.note.${reason}` });
  let data;
  try {
    data = readPhotoData(comp, { maxBytes: DISPLAY_LIMITS.bytes });
  } catch {
    return fail("bad-image");
  }
  if (!data.ok) return fail(data.reason);
  let head;
  try {
    head = base64Prefix(data.base64, HEADER_WINDOW);
  } catch {
    return fail("bad-base64");
  }
  const info = imageInfo(head);
  if (!info.ok) return fail("bad-image");
  if (info.width > DISPLAY_LIMITS.side || info.height > DISPLAY_LIMITS.side) return fail("too-wide");
  if (info.width * info.height > DISPLAY_LIMITS.pixels) return fail("too-many-pixels");
  return { ok: true, mime: info.mime, base64: data.base64, width: info.width, height: info.height };
}
