process.env.TZ = "America/New_York";

import assert from "node:assert/strict";
import { test } from "node:test";
import { parseBody } from "../src/data.ts";
import { parseICS } from "../src/sources/ics.ts";

// Wed 18 Nov 2026, noon in New York: the window runs from 18 Nov 2025 to 18 Nov 2027.
const NOW = new Date(2026, 10, 18, 12, 0);

const calendar = (...events: string[]) => [
  "BEGIN:VCALENDAR", "PRODID:-//Google Inc//Google Calendar 70.9054//EN", "VERSION:2.0", "CALSCALE:GREGORIAN",
  "X-WR-CALNAME:Family", "X-WR-TIMEZONE:America/New_York",
  ...events.map((e) => `BEGIN:VEVENT\r\n${e.trim().replace(/\n/g, "\r\n")}\r\nEND:VEVENT`),
  "END:VCALENDAR", "",
].join("\r\n");

const rowsOf = (uid: string, ics: string) => parseICS(ics, NOW).filter((r) => r.uid === uid);
const starts = (uid: string, ics: string) => rowsOf(uid, ics).map((r) => r.start);

test("a timed event: folded lines, escaped text, the zone it was written in", () => {
  const ics = calendar(`
DTSTART;TZID=America/Los_Angeles:20261203T150000
DTEND;TZID=America/Los_Angeles:20261203T160000
UID:conf@google.com
SUMMARY:Parent-teacher conference
LOCATION:Lincoln Elementary\\, Room 12
DESCRIPTION:Bring the report card.\\nAsk about the science fair\\; and the C:\\\\Temp folder, plus a long line that the exporter had to fol
 d somewhere in the middle.
BEGIN:VALARM
TRIGGER:-PT30M
DESCRIPTION:Reminder
ACTION:DISPLAY
END:VALARM`);
  assert.deepEqual(parseICS(ics, NOW), [{
    summary: "Parent-teacher conference",
    start: "2026-12-03T18:00",
    end: "2026-12-03T19:00",
    allday: false,
    location: "Lincoln Elementary, Room 12",
    description: "Bring the report card.\nAsk about the science fair; and the C:\\Temp folder, plus a long line that the exporter had to fold somewhere in the middle.",
    uid: "conf@google.com",
  }]);
});

test("UTC times, unknown zones and floating times", () => {
  const ics = calendar(
    "DTSTART:20261224T180000Z\nDTEND:20261224T193000Z\nUID:utc\nSUMMARY:Call",
    "DTSTART;TZID=Mars/Olympus_Mons:20261210T090000\nUID:mars\nSUMMARY:Unknown zone",
    "DTSTART;TZID=Eastern Standard Time:20261211T090000\nUID:windows\nSUMMARY:Windows zone name",
    "DTSTART:20261212T071500\nDTEND:20261212T081500\nUID:floating\nSUMMARY:Floating",
  );
  assert.deepEqual(rowsOf("utc", ics).map((r) => [r.start, r.end]), [["2026-12-24T13:00", "2026-12-24T14:30"]]);
  assert.deepEqual(rowsOf("mars", ics).map((r) => [r.start, r.end]), [["2026-12-10T09:00", "2026-12-10T09:00"]]);
  assert.deepEqual(starts("windows", ics), ["2026-12-11T09:00"]);
  assert.deepEqual(rowsOf("floating", ics).map((r) => [r.start, r.end]), [["2026-12-12T07:15", "2026-12-12T08:15"]]);
});

test("all-day events cover their days; the end date in the file is exclusive", () => {
  const ics = calendar(
    "DTSTART;VALUE=DATE:20261224\nDTEND;VALUE=DATE:20261227\nUID:trip\nSUMMARY:Cabin",
    "DTSTART;VALUE=DATE:20261209\nUID:birthday\nSUMMARY:Dad's birthday",
    "DTSTART;VALUE=DATE:20261230\nDTEND;VALUE=DATE:20261231\nUID:one\nSUMMARY:One day",
    "DTSTART;VALUE=DATE:20261215\nDURATION:P3D\nUID:three\nSUMMARY:Three days",
  );
  assert.deepEqual(rowsOf("trip", ics).map((r) => [r.start, r.end, r.allday]), [["2026-12-24", "2026-12-26", true]]);
  assert.deepEqual(rowsOf("birthday", ics).map((r) => [r.start, r.end, r.allday]), [["2026-12-09", "2026-12-09", true]]);
  assert.deepEqual(rowsOf("one", ics).map((r) => [r.start, r.end]), [["2026-12-30", "2026-12-30"]]);
  assert.deepEqual(rowsOf("three", ics).map((r) => [r.start, r.end]), [["2026-12-15", "2026-12-17"]]);
});

test("a missing end is the start; a duration gives one", () => {
  const ics = calendar(
    "DTSTART:20261205T090000\nUID:none\nSUMMARY:No end",
    "DTSTART:20261205T090000\nDURATION:PT1H30M\nUID:hm\nSUMMARY:Hour and a half",
    "DTSTART:20261205T220000\nDURATION:P1DT2H\nUID:dh\nSUMMARY:Overnight",
  );
  assert.deepEqual(rowsOf("none", ics).map((r) => r.end), ["2026-12-05T09:00"]);
  assert.deepEqual(rowsOf("hm", ics).map((r) => r.end), ["2026-12-05T10:30"]);
  assert.deepEqual(rowsOf("dh", ics).map((r) => r.end), ["2026-12-07T00:00"]);
});

test("weekly on some days, with dates left out, until a day", () => {
  const ics = calendar(`
DTSTART;TZID=America/New_York:20261102T170000
DTEND;TZID=America/New_York:20261102T180000
RRULE:FREQ=WEEKLY;BYDAY=MO,WE;UNTIL=20261130T235959Z
EXDATE;TZID=America/New_York:20261111T170000,20261118T170000
EXDATE;TZID=America/New_York:20261125T170000
UID:swim
SUMMARY:Swim practice`);
  const rows = rowsOf("swim", ics);
  assert.deepEqual(rows.map((r) => r.start), [
    "2026-11-02T17:00", "2026-11-04T17:00", "2026-11-09T17:00", "2026-11-16T17:00", "2026-11-23T17:00", "2026-11-30T17:00",
  ]);
  assert.ok(rows.every((r) => String(r.end).endsWith("T18:00") && r.summary === "Swim practice"));
});

test("an every-other-week rule counts from the week of the first date", () => {
  const ics = calendar("DTSTART;VALUE=DATE:20261123\nRRULE:FREQ=WEEKLY;INTERVAL=2;BYDAY=MO,FR;COUNT=5\nUID:biweekly\nSUMMARY:Bins");
  // 23 Nov (Mon), 27 Nov (Fri), then two weeks on: 7 Dec, 11 Dec, 21 Dec.
  assert.deepEqual(starts("biweekly", ics), ["2026-11-23", "2026-11-27", "2026-12-07", "2026-12-11", "2026-12-21"]);
});

test("daily with a count and an interval; monthly skips months without the day", () => {
  const ics = calendar(
    "DTSTART:20261120T080000\nRRULE:FREQ=DAILY;INTERVAL=2;COUNT=3\nUID:daily\nSUMMARY:Pills",
    "DTSTART;VALUE=DATE:20261031\nRRULE:FREQ=MONTHLY;COUNT=4\nUID:monthly\nSUMMARY:Rent review",
  );
  assert.deepEqual(starts("daily", ics), ["2026-11-20T08:00", "2026-11-22T08:00", "2026-11-24T08:00"]);
  // 31 Oct, then 31 Dec (no 31 Nov), 31 Jan, and 31 Mar (no 31 Feb).
  assert.deepEqual(starts("monthly", ics), ["2026-10-31", "2026-12-31", "2027-01-31", "2027-03-31"]);
});

test("yearly: only the years inside the window, however long ago it began", () => {
  const ics = calendar("DTSTART;VALUE=DATE:19900609\nRRULE:FREQ=YEARLY\nUID:bday\nSUMMARY:Anniversary");
  assert.deepEqual(starts("bday", ics), ["2026-06-09", "2027-06-09"]);
});

test("a count includes the occurrences before the window and the ones left out", () => {
  const ics = calendar(`
DTSTART:20251101T090000
RRULE:FREQ=MONTHLY;COUNT=14
EXDATE:20260101T090000
UID:count
SUMMARY:Counted`);
  // 14 occurrences run from Nov 2025 to Dec 2026 (the January one is one of them); Nov 2025 is before the window.
  const rows = starts("count", ics);
  assert.equal(rows[0], "2025-12-01T09:00");
  assert.equal(rows.at(-1), "2026-12-01T09:00");
  assert.equal(rows.length, 12);
});

test("a rule is expanded in the zone it was written in, so the local hour follows each zone's clock changes", () => {
  const ics = calendar("DTSTART;TZID=Europe/London:20261016T180000\nRRULE:FREQ=WEEKLY;COUNT=4\nUID:london\nSUMMARY:Call home");
  // London went back to GMT on 25 Oct, New York on 1 Nov.
  assert.deepEqual(starts("london", ics), ["2026-10-16T13:00", "2026-10-23T13:00", "2026-10-30T14:00", "2026-11-06T13:00"]);
});

test("rules this reader doesn't expand leave the event as one row", () => {
  const ics = calendar(
    "DTSTART;VALUE=DATE:20261109\nRRULE:FREQ=MONTHLY;BYDAY=2MO\nUID:ordinal\nSUMMARY:Book club",
    "DTSTART;VALUE=DATE:20261115\nRRULE:FREQ=MONTHLY;BYMONTHDAY=15\nUID:monthday\nSUMMARY:Pay card",
    "DTSTART;VALUE=DATE:20261116\nRRULE:FREQ=MONTHLY;BYSETPOS=-1;BYDAY=MO\nUID:setpos\nSUMMARY:Last Monday",
    "DTSTART;VALUE=DATE:20261117\nRRULE:FREQ=DAILY;BYDAY=MO\nUID:daily-byday\nSUMMARY:Daily on Mondays",
    "DTSTART;VALUE=DATE:20261118\nRRULE:FREQ=HOURLY\nUID:hourly\nSUMMARY:Hourly",
  );
  assert.deepEqual(starts("ordinal", ics), ["2026-11-09"]);
  assert.deepEqual(starts("monthday", ics), ["2026-11-15"]);
  assert.deepEqual(starts("setpos", ics), ["2026-11-16"]);
  assert.deepEqual(starts("daily-byday", ics), ["2026-11-17"]);
  assert.deepEqual(starts("hourly", ics), ["2026-11-18"]);
});

test("an edited or cancelled occurrence replaces the one the rule made", () => {
  const ics = calendar(
    "DTSTART;TZID=America/New_York:20261105T190000\nDTEND;TZID=America/New_York:20261105T200000\nRRULE:FREQ=WEEKLY;COUNT=4\nUID:choir\nSUMMARY:Choir",
    "RECURRENCE-ID;TZID=America/New_York:20261112T190000\nDTSTART;TZID=America/New_York:20261112T180000\nDTEND;TZID=America/New_York:20261112T190000\nUID:choir\nSUMMARY:Choir (early)",
    "RECURRENCE-ID;TZID=America/New_York:20261119T190000\nDTSTART;TZID=America/New_York:20261119T190000\nUID:choir\nSTATUS:CANCELLED\nSUMMARY:Choir",
  );
  assert.deepEqual(rowsOf("choir", ics).map((r) => [r.start, r.summary]), [
    ["2026-11-05T19:00", "Choir"], ["2026-11-12T18:00", "Choir (early)"], ["2026-11-26T19:00", "Choir"],
  ]);
});

test("rows come back sorted by start, all-day first on their day", () => {
  const ics = calendar(
    "DTSTART:20261203T090000\nUID:b\nSUMMARY:b",
    "DTSTART;VALUE=DATE:20261203\nUID:a\nSUMMARY:a",
    "DTSTART:20261201T090000\nUID:c\nSUMMARY:c",
  );
  assert.deepEqual(parseICS(ics, NOW).map((r) => r.uid), ["c", "a", "b"]);
});

test("events that can't be read are skipped, never thrown", () => {
  const ics = [
    "BEGIN:VCALENDAR",
    "BEGIN:VEVENT\nUID:nostart\nSUMMARY:No start\nEND:VEVENT",
    "BEGIN:VEVENT\nDTSTART:tomorrow\nUID:garbage\nSUMMARY:Garbage start\nEND:VEVENT",
    "BEGIN:VEVENT\nDTSTART;VALUE=DATE:20261302\nUID:month13\nSUMMARY:Month 13\nEND:VEVENT",
    "BEGIN:VEVENT\nDTSTART;VALUE=DATE:20261210\nRRULE:FREQ=WEEKLY;COUNT=zero\nUID:badcount\nSUMMARY:Bad count\nEND:VEVENT",
    "BEGIN:VEVENT\nDTSTART;VALUE=DATE:20261211\nUID:fine\nSUMMARY:Fine\nEND:VEVENT",
    "BEGIN:VEVENT\nDTSTART;VALUE=DATE:20261212\nUID:cut\nSUMMARY:Cut off",
  ].join("\n");
  assert.deepEqual(parseICS(ics, NOW).map((r) => r.uid), ["badcount", "fine"]);
  assert.deepEqual(parseICS("", NOW), []);
  assert.deepEqual(parseICS("BEGIN:VCALENDAR\nEND:VCALENDAR", NOW), []);
});

test("parseBody takes a calendar by its start or its content type, and leaves JSON alone", () => {
  const ics = calendar("DTSTART;VALUE=DATE:20261211\nUID:x\nSUMMARY:X");
  assert.equal((parseBody(ics, "text/plain", NOW) as unknown[]).length, 1);
  assert.equal((parseBody(`﻿${ics}`, "", NOW) as unknown[]).length, 1);
  assert.deepEqual(parseBody("", "text/calendar; charset=utf-8", NOW), []);
  assert.deepEqual(parseBody('{"a":1}', "application/vnd.calendar+json", NOW), { a: 1 });
});
