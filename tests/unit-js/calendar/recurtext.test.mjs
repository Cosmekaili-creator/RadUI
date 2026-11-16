// SPDX-License-Identifier: AGPL-3.0-or-later
import test from "node:test";
import assert from "node:assert/strict";
import { createI18n, checkParity } from "../../../src/js/i18n.js";
import en from "../../../src/i18n/en.recur.js";
import fr from "../../../src/i18n/fr.recur.js";
import { summarizeRule, summarizeState, weekdayName, monthName } from "../../../src/js/calendar/recurtext.js";
import { defaultState } from "../../../src/js/calendar/rrule.js";

const dictionaries = { en, fr };
const i18n = (lang) => createI18n({ dictionaries, lang });
const START = { kind: "zoned", iso: "2026-03-23T10:00:00", tzid: "Europe/Paris" }; // a Monday
const say = (lang, rule, start = START) => {
  const i = i18n(lang);
  return summarizeRule(rule, start, { t: i.t, tp: i.tp, lang });
};
const dateOf = (lang, y, m, d) => new Intl.DateTimeFormat(lang, { dateStyle: "medium", timeZone: "UTC" }).format(new Date(Date.UTC(y, m - 1, d)));

test("the recurrence dictionary has identical keys and placeholders in FR and EN", () => {
  assert.deepEqual(checkParity({ en, fr }).problems, []);
  assert.deepEqual(Object.keys(en).sort(), Object.keys(fr).sort());
});

test("English: 12 patterns", () => {
  assert.equal(say("en", null), "Does not repeat");
  assert.equal(say("en", "FREQ=DAILY"), "Every day");
  assert.equal(say("en", "FREQ=DAILY;INTERVAL=3"), "Every 3 days");
  assert.equal(say("en", "FREQ=WEEKLY;BYDAY=MO"), "Every week on Monday");
  assert.equal(say("en", "FREQ=WEEKLY;INTERVAL=2;BYDAY=MO,TH;UNTIL=20261231T225959Z"), `Every 2 weeks on Monday and Thursday, until ${dateOf("en", 2026, 12, 31)}`);
  assert.equal(say("en", "FREQ=WEEKLY;BYDAY=MO,WE,FR;COUNT=8"), "Every week on Monday, Wednesday, and Friday, for 8 occurrences");
  assert.equal(say("en", "FREQ=WEEKLY"), "Every week on Monday", "implicit weekday from the start");
  assert.equal(say("en", "FREQ=MONTHLY;BYMONTHDAY=15"), "Every month on day 15");
  assert.equal(say("en", "FREQ=MONTHLY;BYDAY=2TU"), "Every month on the second Tuesday");
  assert.equal(say("en", "FREQ=MONTHLY;INTERVAL=3;BYDAY=-1FR;COUNT=1"), "Every 3 months on the last Friday, for 1 occurrence");
  assert.equal(say("en", "FREQ=YEARLY"), "Every year on March 23");
  assert.equal(say("en", "FREQ=YEARLY;BYMONTH=11;BYDAY=4TH"), "Every year on the fourth Thursday of November");
  assert.equal(say("en", "FREQ=MONTHLY;BYDAY=MO,TU,WE,TH,FR;BYSETPOS=-1"), "Custom rule (kept as is)");
});

test("French: the same 12 patterns", () => {
  assert.equal(say("fr", null), "Ne se répète pas");
  assert.equal(say("fr", "FREQ=DAILY"), "Tous les jours");
  assert.equal(say("fr", "FREQ=DAILY;INTERVAL=3"), "Tous les 3 jours");
  assert.equal(say("fr", "FREQ=WEEKLY;BYDAY=MO"), "Toutes les semaines le lundi");
  assert.equal(say("fr", "FREQ=WEEKLY;INTERVAL=2;BYDAY=MO,TH;UNTIL=20261231T225959Z"), `Toutes les 2 semaines le lundi et le jeudi, jusqu’au ${dateOf("fr", 2026, 12, 31)}`);
  assert.equal(say("fr", "FREQ=WEEKLY;BYDAY=MO,WE,FR;COUNT=8"), "Toutes les semaines le lundi, le mercredi et le vendredi, pour 8 occurrences");
  assert.equal(say("fr", "FREQ=WEEKLY"), "Toutes les semaines le lundi");
  assert.equal(say("fr", "FREQ=MONTHLY;BYMONTHDAY=15"), "Tous les mois le 15");
  assert.equal(say("fr", "FREQ=MONTHLY;BYMONTHDAY=1"), "Tous les mois le 1er");
  assert.equal(say("fr", "FREQ=MONTHLY;BYDAY=2TU"), "Tous les mois le deuxième mardi");
  assert.equal(say("fr", "FREQ=MONTHLY;INTERVAL=3;BYDAY=-1FR;COUNT=1"), "Tous les 3 mois le dernier vendredi, pour 1 occurrence");
  assert.equal(say("fr", "FREQ=YEARLY"), "Tous les ans le 23 mars");
  assert.equal(say("fr", "FREQ=YEARLY;BYMONTH=11;BYDAY=4TH"), "Tous les ans le quatrième jeudi de novembre");
  assert.equal(say("fr", "FREQ=YEARLY;BYMONTH=4;BYDAY=1SU"), "Tous les ans le premier dimanche d’avril");
  assert.equal(say("fr", "FREQ=DAILY;BYHOUR=9"), "Règle personnalisée (conservée telle quelle)");
});

test("names come from Intl, in the requested language", () => {
  assert.equal(weekdayName("TH", "en"), "Thursday");
  assert.equal(weekdayName("TH", "fr"), "jeudi");
  assert.equal(monthName(8, "fr"), "août");
  assert.equal(monthName(8, "en"), "August");
});

test("summarizeState accepts a builder state directly", () => {
  const i = i18n("en");
  const st = { ...defaultState(START, "WEEKLY"), byday: ["TU", "SA"], interval: 2 };
  assert.equal(summarizeState(st, { t: i.t, tp: i.tp, lang: "en", startSpec: START }), "Every 2 weeks on Tuesday and Saturday");
});
