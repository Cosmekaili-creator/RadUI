// SPDX-License-Identifier: AGPL-3.0-or-later
// Stub module for the S11 CSP check: an ES module that imports the vendored ical.js build
// (same origin, no inline code) and reports readiness through the DOM.
import ICAL from "./ical.min.js";

const root = document.getElementById("root");
const comp = new ICAL.Component(ICAL.parse("BEGIN:VCALENDAR\r\nVERSION:2.0\r\nPRODID:-//Example//Stub//EN\r\nEND:VCALENDAR\r\n"));
root.dataset.state = "ready";
root.dataset.ical = comp.getFirstPropertyValue("version");
document.querySelector("[data-testid=status]").textContent = "ready";
root.classList.add("ready"); // styling through a class, never a style attribute
