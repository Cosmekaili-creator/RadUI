// SPDX-License-Identifier: AGPL-3.0-or-later
// Shared, DOM-free S12 probe: the same code runs in Node and in Chromium so the two
// results can be compared field by field. Input: the ICAL module and a map of fixture
// name -> text. Output: plain JSON-serialisable data.

export const FIXTURES = [
  "vcard30-groups.vcf",
  "vcard40-groups.vcf",
  "event-tzid-quoted.ics",
  "event-recur-exdate-override.ics",
  "event-fold-params.ics",
];

export function probe(ICAL, texts) {
  const res = { roundTrip: {}, tzidQuoted: {}, recurrence: [], touched: {} };

  for (const f of FIXTURES) {
    res.roundTrip[f] = new ICAL.Component(ICAL.parse(texts[f])).toString();
  }

  // quoted TZID without VTIMEZONE
  {
    const vevent = new ICAL.Component(ICAL.parse(texts["event-tzid-quoted.ics"])).getFirstSubcomponent("vevent");
    const t = vevent.getFirstPropertyValue("dtstart");
    res.tzidQuoted = { zone: t.zone && t.zone.tzid, unix: t.toUnixTime(), iso: t.toJSDate().toISOString() };
  }

  // recurrence with EXDATE and RECURRENCE-ID override, VTIMEZONE carried by the file
  {
    const comp = new ICAL.Component(ICAL.parse(texts["event-recur-exdate-override.ics"]));
    ICAL.TimezoneService.register(comp.getFirstSubcomponent("vtimezone"));
    const vevents = comp.getAllSubcomponents("vevent");
    const master = new ICAL.Event(vevents.find((v) => !v.hasProperty("recurrence-id")));
    master.relateException(new ICAL.Event(vevents.find((v) => v.hasProperty("recurrence-id"))));
    const it = master.iterator();
    for (let next, n = 0; (next = it.next()) && n < 20; n++) {
      const d = master.getOccurrenceDetails(next);
      res.recurrence.push([d.startDate.toString(), d.startDate.toJSDate().toISOString(), d.item.summary]);
    }
    ICAL.TimezoneService.remove("Europe/Paris");
  }

  // a touched property: folding of a long value with multi-byte characters
  {
    const comp = new ICAL.Component(ICAL.parse(texts["event-fold-params.ics"]));
    const vevent = comp.getFirstSubcomponent("vevent");
    vevent.updatePropertyWithValue("summary", "Café à la crème — 日本語のテスト 😀 ".repeat(6));
    res.touched.componentText = comp.toString();
  }
  return res;
}
