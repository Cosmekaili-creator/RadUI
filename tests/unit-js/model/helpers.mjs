// SPDX-License-Identifier: AGPL-3.0-or-later
// Shared helpers for the data-model tests (no tests in here).
import { readFileSync, readdirSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

const here = path.dirname(fileURLToPath(import.meta.url));
export const FIXTURES = path.resolve(here, "../../fixtures");

/** A backslash, spelled out so no editor or template mangles it. */
export const BS = String.fromCharCode(92);

export const manifest = JSON.parse(readFileSync(path.join(FIXTURES, "manifest.json"), "utf8"));

/** [{name, file, text, meta}] for every fixture (text is the file as stored, decoded as UTF-8). */
export function fixtures() {
  const out = [];
  for (const dir of ["ics", "vcf"]) {
    for (const f of readdirSync(path.join(FIXTURES, dir)).filter((n) => n.endsWith("." + dir)).sort()) {
      const key = `${dir}/${f}`;
      out.push({ name: key, file: f, text: readFileSync(path.join(FIXTURES, key), "utf8"), meta: manifest[key] || {} });
    }
  }
  return out;
}

export const fixture = (name) => {
  const f = fixtures().find((x) => x.name === name || x.file === name);
  if (!f) throw new Error(`no fixture ${name}`);
  return f.text;
};

export const lf = (t) => t.replace(/\r\n?/g, "\n");
/** The LF-normalised text re-emitted with CRLF and a final CRLF, blank lines dropped. */
export const crlf = (t) => lf(t).split("\n").filter((l) => l !== "").join("\r\n") + "\r\n";
/** Physical lines of a CRLF text. */
export const physical = (t) => t.split("\r\n").filter((l) => l !== "");
export const unfold = (t) => lf(t).replace(/\n[ \t]/g, "");
export const logical = (t) => unfold(t).split("\n").filter((l) => l !== "");
export const octets = (s) => new TextEncoder().encode(s).length;
export const D = (iso) => new Date(iso);
