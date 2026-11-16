// SPDX-License-Identifier: AGPL-3.0-or-later
// The human readable recurrence sentence ("Every 2 weeks on Monday and Thursday, until 31 Dec 2026").
// Built from i18n templates (keys `recur.*`, see src/i18n/{en,fr}.recur.js) plus Intl weekday, month
// and date names; never by concatenating English words. No DOM.
//
//   summarizeState(state, {t, tp, lang, startSpec})
//   summarizeRule(text, startSpec, {t, tp, lang, zones})   text may be null ("Does not repeat")

import { WEEKDAYS, parseRule } from "./rrule.js";

const FREQ_KEY = { DAILY: "day", WEEKLY: "week", MONTHLY: "month", YEARLY: "year" };

function fmt(lang, options) {
  try {
    return new Intl.DateTimeFormat(lang, { timeZone: "UTC", ...options });
  } catch {
    return new Intl.DateTimeFormat("en", { timeZone: "UTC", ...options });
  }
}

/** Long weekday name of a two-letter code (MO..SU) in `lang`. */
export function weekdayName(code, lang) {
  const i = WEEKDAYS.indexOf(code);
  return fmt(lang, { weekday: "long" }).format(new Date(Date.UTC(2024, 0, 1 + (i < 0 ? 0 : i))));
}

/** Long month name (1..12) in `lang`. */
export function monthName(month, lang) {
  return fmt(lang, { month: "long" }).format(new Date(Date.UTC(2024, month - 1, 1)));
}

function list(items, lang) {
  try {
    return new Intl.ListFormat(lang, { style: "long", type: "conjunction" }).format(items);
  } catch {
    return items.join(", ");
  }
}

const dateText = (iso, lang) => fmt(lang, { dateStyle: "medium" }).format(new Date(Date.UTC(+iso.slice(0, 4), +iso.slice(5, 7) - 1, +iso.slice(8, 10))));
const dayMonthText = (month, day, lang) => fmt(lang, { day: "numeric", month: "long" }).format(new Date(Date.UTC(2024, month - 1, day)));

/** The sentence of a builder state. `startSpec` supplies the implicit parts (weekday, day, month). */
export function summarizeState(state, { t, tp, lang = "en", startSpec = null } = {}) {
  const startIso = startSpec && startSpec.iso ? startSpec.iso.slice(0, 10) : null;
  const key = FREQ_KEY[state.freq];
  const every = tp(`recur.every.${key}`, state.interval);
  let on = "";
  if (state.freq === "WEEKLY") {
    let codes = state.byday || [];
    if (!codes.length && startIso) codes = [WEEKDAYS[(new Date(Date.UTC(+startIso.slice(0, 4), +startIso.slice(5, 7) - 1, +startIso.slice(8, 10))).getUTCDay() + 6) % 7]];
    if (codes.length) {
      const items = codes.map((c) => t("recur.weekday.item", { day: weekdayName(c, lang) }));
      on = t("recur.on.weekdays", { days: list(items, lang) });
    }
  } else if (state.freq === "MONTHLY") {
    if (state.monthly === "nth" && state.nth) {
      on = t("recur.on.nth", { nth: t(`recur.nth.${state.nth.n}`), weekday: weekdayName(state.nth.weekday, lang) });
    } else {
      const day = state.bymonthday || (startIso ? +startIso.slice(8, 10) : null);
      if (day) on = tp("recur.on.monthday", day, { day });
    }
  } else if (state.freq === "YEARLY") {
    const month = state.bymonth || (state.monthly !== "nth" && startIso ? +startIso.slice(5, 7) : null);
    if (state.monthly === "nth" && state.nth && state.bymonth) {
      const name = monthName(state.bymonth, lang);
      const vowel = /^[aeiouàâéèêîôûh]/i.test(name);
      on = t("recur.on.yearly.nth", {
        nth: t(`recur.nth.${state.nth.n}`),
        weekday: weekdayName(state.nth.weekday, lang),
        month: t(vowel ? "recur.of.vowel" : "recur.of.consonant", { month: name }),
      });
    } else if (month) {
      const day = state.bymonthday || (startIso ? +startIso.slice(8, 10) : null);
      if (day) on = t("recur.on.date", { date: dayMonthText(month, day, lang) });
    }
  }
  const base = on ? `${every} ${on}` : every;
  const end = state.end || { type: "never" };
  if (end.type === "until") return t("recur.sentence", { base, end: t("recur.end.until", { date: dateText(end.date, lang) }) });
  if (end.type === "count") return t("recur.sentence", { base, end: tp("recur.end.count", end.count) });
  return base;
}

/** Sentence of an RRULE text: "Does not repeat" for none, the custom label for a rule the builder cannot edit. */
export function summarizeRule(text, startSpec, { t, tp, lang = "en", zones } = {}) {
  if (!text || !String(text).trim()) return t("recur.none");
  const parsed = parseRule(text, startSpec, { zones });
  if (parsed.custom) return t("recur.custom");
  return summarizeState(parsed.state, { t, tp, lang, startSpec });
}
