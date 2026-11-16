// SPDX-License-Identifier: AGPL-3.0-or-later
import test from "node:test";
import assert from "node:assert/strict";
import {
  Property,
  ParseError,
  ValueError,
  escapeText,
  formatDuration,
  formatRRule,
  formatTime,
  logicalLines,
  normalizeNewlines,
  parse,
  parseContentLine,
  parseDuration,
  parseRRule,
  parseTime,
  specFromWallMs,
  specWallMs,
  splitUnescaped,
  unescapeText,
} from "../../../src/js/model/contentlines.js";
import { BS } from "./helpers.mjs";

const doc = (lines, eol = "\r\n") => lines.join(eol) + eol;
const MIN = ["BEGIN:VCALENDAR", "VERSION:2.0", "BEGIN:VEVENT", "UID:a", "SUMMARY:x", "END:VEVENT", "END:VCALENDAR"];

test("CRLF, LF, lone CR and mixed endings give the same tree", () => {
  const dump = (t) => JSON.stringify(parse(t));
  const ref = dump(doc(MIN, "\r\n"));
  assert.equal(dump(doc(MIN, "\n")), ref);
  assert.equal(dump(doc(MIN, "\r")), ref);
  const mixed = MIN[0] + "\r\n" + MIN[1] + "\n" + MIN.slice(2, 5).join("\r") + "\r" + MIN.slice(5).join("\n");
  assert.equal(dump(mixed), ref);
});

test("normalizeNewlines drops a BOM and converts every ending", () => {
  assert.equal(normalizeNewlines("﻿A\r\nB\rC\nD"), "A\nB\nC\nD");
});

test("unfolding removes exactly one leading space or tab", () => {
  const lines = logicalLines("SUMMARY:ab\n cd\n\tef\n  gh\nX:1\n");
  assert.equal(lines.length, 2);
  assert.equal(lines[0].raw, "SUMMARY:abcdef gh");
  assert.equal(lines[0].folded, "SUMMARY:ab\n cd\n\tef\n  gh");
  assert.equal(lines[1].raw, "X:1");
});

test("a continuation line with nothing before it is an error", () => {
  assert.throws(() => logicalLines(" orphan\n"), ParseError);
});

test("blank lines are ignored and the final newline is optional", () => {
  const a = parse("BEGIN:X\n\nA:1\n\nEND:X");
  const b = parse("BEGIN:X\nA:1\nEND:X\n");
  assert.equal(JSON.stringify(a), JSON.stringify(b));
});

test("property groups: item1.TEL", () => {
  const p = parseContentLine("item1.TEL;type=pref:+1 555 0100");
  assert.equal(p.group, "item1");
  assert.equal(p.name, "TEL");
  const q = new Property({ ...p, raw: "x" });
  assert.equal(q.key, "TEL");
  assert.equal(q.groupKey, "ITEM1");
});

test("parameters: quoted values may hold colon, semicolon and comma", () => {
  const p = parseContentLine('ATTENDEE;CN="Doe; John, Jr.: the third";ROLE=CHAIR:mailto:john@example.org');
  assert.equal(p.params.length, 2);
  assert.deepEqual(p.params[0].values, [{ text: "Doe; John, Jr.: the third", quoted: true }]);
  assert.equal(p.value, "mailto:john@example.org");
});

test("multi-valued and repeated parameters", () => {
  const p = parseContentLine('TEL;TYPE=HOME,VOICE;TYPE="a,b";PREF=1:123');
  assert.deepEqual(p.params[0].values.map((v) => v.text), ["HOME", "VOICE"]);
  assert.deepEqual(p.params[1].values, [{ text: "a,b", quoted: true }]);
  const prop = new Property({ ...p, raw: "x" });
  assert.deepEqual(prop.paramValues("type"), ["HOME", "VOICE", "a,b"]);
});

test("bare parameters (vCard 2.1 style), empty values and caret escapes are kept raw", () => {
  const p = parseContentLine("TEL;WORK;VOICE;X-EMPTY=;X-CARET=a^'b^^c:1");
  assert.equal(p.params[0].bare, true);
  assert.equal(p.params[2].values[0].text, "");
  assert.equal(p.params[3].values[0].text, "a^'b^^c");
});

test("values keep colons, quotes and everything after the first unquoted colon", () => {
  assert.equal(parseContentLine("URL:https://example.org/a?b=c:d").value, "https://example.org/a?b=c:d");
  assert.equal(parseContentLine('X:say "hi"; ok, fine').value, 'say "hi"; ok, fine');
  assert.equal(parseContentLine("X-EMPTY:").value, "");
});

test("a property keeps its original text and folding", () => {
  const roots = parse("BEGIN:X\nSUMMARY:aa\n bb\nEND:X\n");
  const p = roots[0].prop("summary");
  assert.equal(p.raw, "SUMMARY:aabb");
  assert.equal(p.folded, "SUMMARY:aa\n bb");
  assert.equal(p.dirty, false);
  assert.equal(p.value, "aabb");
});

test("structural errors are ParseErrors", () => {
  const bad = [
    "BEGIN:X\nno colon here\nEND:X\n",
    "BEGIN:X\nA:1\n",
    "A:1\n",
    "BEGIN:X\nEND:Y\n",
    "END:X\n",
    'BEGIN:X\nA;P="unterminated:1\nEND:X\n',
    'BEGIN:X\nA;P="q"x:1\nEND:X\n',
    "BEGIN:X\nbad name:1\nEND:X\n",
    "BEGIN:X\nA;=v:1\nEND:X\n",
    "BEGIN:X;P=1\nEND:X\n",
  ];
  for (const t of bad) assert.throws(() => parse(t), ParseError, t);
  const deep = Array.from({ length: 10 }, (_, i) => `BEGIN:C${i}`).join("\n") + "\n" + Array.from({ length: 10 }, (_, i) => `END:C${9 - i}`).join("\n");
  assert.throws(() => parse(deep), ParseError);
});

test("component names compare case-insensitively and nest", () => {
  const roots = parse("begin:vcalendar\nBEGIN:VEVENT\nUID:1\nEND:vevent\nend:VCALENDAR\n");
  assert.equal(roots.length, 1);
  assert.equal(roots[0].comp("vevent").prop("uid").value, "1");
  assert.equal(roots[0].beginRaw, "begin:vcalendar");
});

test("several top-level components are returned as a list", () => {
  assert.equal(parse("BEGIN:VCARD\nEND:VCARD\nBEGIN:VCARD\nEND:VCARD\n").length, 2);
});

test("TEXT escaping round trip", () => {
  const s = `a,b;c${BS}d\ne`;
  const esc = escapeText(s);
  assert.equal(esc, `a${BS},b${BS};c${BS}${BS}d${BS}ne`);
  assert.equal(unescapeText(esc), s);
  assert.equal(unescapeText(`x${BS}Ny${BS}qz`), "x\nyqz");
});

test("splitUnescaped respects escapes", () => {
  assert.deepEqual(splitUnescaped(`a${BS},b,c${BS}${BS},d`, ","), [`a${BS},b`, `c${BS}${BS}`, "d"]);
  assert.deepEqual(splitUnescaped("", ";"), [""]);
});

test("date and date-time codecs", () => {
  assert.deepEqual(parseTime("20260401", []), { kind: "date", iso: "2026-04-01" });
  assert.deepEqual(parseTime("20260401T100000Z", []), { kind: "utc", iso: "2026-04-01T10:00:00" });
  assert.deepEqual(parseTime("20260401T100000", []), { kind: "floating", iso: "2026-04-01T10:00:00" });
  const tz = [{ name: "tzid", values: [{ text: "Europe/Paris", quoted: false }] }];
  assert.deepEqual(parseTime("20260401T100000", tz), { kind: "zoned", iso: "2026-04-01T10:00:00", tzid: "Europe/Paris" });
  const val = [{ name: "VALUE", values: [{ text: "DATE", quoted: false }] }];
  assert.deepEqual(parseTime("20260401", val), { kind: "date", iso: "2026-04-01" });
  for (const bad of ["2026-04-01", "20261301", "20260230", "20260401T250000", "garbage", ""]) {
    assert.throws(() => parseTime(bad, []), ValueError, bad);
  }
  assert.deepEqual(formatTime({ kind: "date", iso: "2026-04-01" }), { value: "20260401", valueDate: true, tzid: null });
  assert.equal(formatTime({ kind: "utc", iso: "2026-04-01T10:00:00" }).value, "20260401T100000Z");
  assert.equal(formatTime({ kind: "zoned", iso: "2026-04-01T10:00:00", tzid: "X/Y" }).tzid, "X/Y");
  assert.throws(() => formatTime({ kind: "zoned", iso: "2026-04-01T10:00:00" }), ValueError);
  const ms = specWallMs({ kind: "floating", iso: "2026-04-01T10:30:15" });
  assert.deepEqual(specFromWallMs(ms, "floating"), { kind: "floating", iso: "2026-04-01T10:30:15" });
});

test("duration codec", () => {
  assert.equal(parseDuration("PT1H30M"), 5400);
  assert.equal(parseDuration("-PT15M"), -900);
  assert.equal(parseDuration("P1W"), 604800);
  assert.equal(parseDuration("P1DT2H"), 93600);
  assert.equal(formatDuration(-900), "-PT15M");
  assert.equal(formatDuration(5400), "PT1H30M");
  assert.equal(formatDuration(86400), "P1D");
  assert.equal(formatDuration(604800), "P1W");
  assert.equal(formatDuration(0), "PT0S");
  for (const s of [0, 60, 3600, 90061, -86400 * 3]) assert.equal(parseDuration(formatDuration(s)), s);
  for (const bad of ["P", "PT", "1H", "P1H", ""]) assert.throws(() => parseDuration(bad), ValueError, bad);
});

test("RRULE codec keeps unknown parts and order", () => {
  const p = parseRRule("freq=weekly;X-EXT=1;COUNT=3");
  assert.deepEqual(p[0], ["FREQ", "weekly"]);
  assert.equal(formatRRule(p), "FREQ=weekly;X-EXT=1;COUNT=3");
  assert.throws(() => parseRRule("COUNT=3"), ValueError);
});
