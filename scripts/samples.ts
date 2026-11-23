// The gallery's sample rows, written for a day: the logged rows in each kind's data note, the other
// lines in a log of a device called "sample" (a planned chore already done names the data note's row
// that settled it, by the id the note gives that row), the bank, health and broker exports in Inbox,
// and the Trip planner's departure, return and itinerary. They are authored for REFERENCE (a Wednesday) and moved whole to the day
// asked for, so the story reads the same from any day: a bill six days overdue is still six days
// overdue, today's dose still due. A monthly bill keeps the day of the month of its first time.
//
//   node scripts/samples.ts [YYYY-MM-DD | today] [gallery folder]
//
// writes them into the folder (the repo's gallery/ by default), replacing the sample files of an
// earlier day. The repo keeps them written for REFERENCE, the day the unit tests' clock reads; the
// live checks write them for the day they run on into their copy of the gallery.
import { createHash } from "node:crypto";
import { mkdirSync, readFileSync, readdirSync, rmSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { baseIds } from "../src/ledger.ts";

export const REFERENCE = "2026-11-18";

type Row = Record<string, string | number>;
type Logged = { row: Row; t: string; seed: string };

const pad = (n: number) => String(n).padStart(2, "0");
const id = (seed: string) => createHash("sha256").update(seed).digest("hex").slice(0, 16);
const q = (v: string | number) => (typeof v === "number" ? String(v) : JSON.stringify(v));
const flow = (row: Row) => `{${Object.entries(row).map(([k, v]) => `${k}: ${q(v)}`).join(", ")}}`;
const note = (list: string, rows: Row[]) => `---\n${list}:\n${rows.map((r) => `  - ${flow(r)}`).join("\n")}\n---\n`;
const ymd = (d: Date) => `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())}`;
const stampOf = (d: Date) => `${ymd(d)}T${pad(d.getHours())}:${pad(d.getMinutes())}`;
const daysInMonth = (y: number, m: number) => new Date(y, m + 1, 0).getDate();

/** The day `day` names: `today`, or `YYYY-MM-DD`. */
export function dayOf(day: string, now = new Date()): Date {
  if (day === "today") return new Date(now.getFullYear(), now.getMonth(), now.getDate());
  const m = /^(\d{4})-(\d{2})-(\d{2})$/.exec(day);
  if (!m) throw new Error(`a day is today or YYYY-MM-DD, not "${day}"`);
  return new Date(Number(m[1]), Number(m[2]) - 1, Number(m[3]));
}

/**
 * Every sample file for `day`, by its path in the gallery, with its text; and the Trip planner's
 * `departs` and `returns`, which `departed` writes into its note.
 */
export function sampleFiles(day: Date): { files: Record<string, string>; departs: string; returns: string } {
  const [ry, rm, rd] = REFERENCE.split("-").map(Number);
  const by = Math.round((day.getTime() - new Date(ry, rm - 1, rd).getTime()) / 86_400_000);
  /** A time as authored for REFERENCE, moved to `day`. */
  const at = (y: number, m: number, d: number, h = 9, mi = 0) => new Date(y, m - 1, d + by, h, mi);
  /** A UTC time as authored, moved by as many days. */
  const utc = (text: string) => new Date(Date.parse(`${text}Z`) + by * 86_400_000).toISOString().slice(0, 19);
  const files: Record<string, string> = {};

  /** One log file per month of the events' times: `{t, d, op: add, l, row, v}`. */
  const logs = (folder: string, list: string, items: Logged[]) => {
    const byMonth = new Map<string, string[]>();
    items.forEach(({ row, t, seed }, i) => {
      const e = { t: `${t}.000Z/${i}`, d: "sample", op: "add", l: list, row: id(`${list}\n${seed}`), v: row };
      byMonth.set(t.slice(0, 7), [...(byMonth.get(t.slice(0, 7)) ?? []), JSON.stringify(e)]);
    });
    for (const [month, lines] of byMonth) files[`${folder}/sample-${month}.jsonl`] = `${lines.join("\n")}\n`;
  };

  // ---- Spend ----------------------------------------------------------------------------------
  const spend: Row[] = ([
    [10, 1, 9, 5, 1450, "home", "OAKWOOD APARTMENTS"], [10, 2, 18, 20, 92.15, "food", "groceries"],
    [10, 4, 8, 30, 88.13, "home", "CITY POWER & LIGHT"], [10, 5, 7, 0, 10.99, "fun", "TUNEBOX MUSIC"],
    [10, 6, 12, 40, 13.2, "food", "lunch"], [10, 9, 18, 0, 104.55, "food", "groceries"],
    [10, 10, 7, 0, 39, "fun", "PEAK FITNESS"], [10, 12, 7, 0, 15.49, "fun", "STREAMFLIX"],
    [10, 14, 17, 30, 41.8, "transport", "fuel"], [10, 16, 7, 0, 38.2, "home", "METRO WATER"],
    [10, 17, 19, 30, 62, "fun", "dinner out"], [10, 18, 7, 0, 65, "home", "FASTNET INTERNET"],
    [10, 20, 11, 0, 76.4, "food", "groceries"], [10, 24, 15, 0, 120, "other", "birthday present"],
    [10, 25, 7, 0, 45, "home", "BRIGHT MOBILE"], [10, 27, 18, 10, 93.7, "food", "groceries"],
    [10, 29, 8, 15, 4.5, "food", "coffee"], [10, 31, 20, 0, 38, "fun", "cinema"],
    [11, 1, 9, 10, 1450, "home", "OAKWOOD APARTMENTS"], [11, 2, 18, 5, 86.42, "food", "groceries"],
    [11, 4, 8, 20, 92.4, "home", "CITY POWER & LIGHT"], [11, 5, 7, 0, 10.99, "fun", "TUNEBOX MUSIC"],
    [11, 7, 10, 30, 20, "food", "farmers market, cash"], [11, 8, 19, 45, 48, "fun", "dinner with Sam"],
    [11, 9, 17, 50, 112.3, "food", "groceries"], [11, 10, 7, 0, 39, "fun", "PEAK FITNESS"],
    [11, 13, 17, 40, 44.1, "transport", "fuel"], [11, 15, 11, 20, 64.18, "food", "groceries"],
    [11, 17, 8, 10, 4.5, "food", "coffee"],
  ] as const).map(([m, d, h, mi, amount, category, n]) => ({ amount, category, note: n, at: stampOf(at(2026, m, d, h, mi)) }));
  // What Household chores' upkeep cost, months ago: so Budget counted it then.
  spend.push({ amount: 189, category: "transport", note: "Upkeep: car service", at: stampOf(at(2026, 7, 25, 11, 0)) });
  spend.push({ amount: 24.99, category: "home", note: "Upkeep: furnace filter", at: stampOf(at(2026, 9, 13, 10, 45)) });
  // The trip to Tokyo of Trip planner: its flights, paid when booked, and what it plans to cost there.
  spend.push({ amount: 1240, category: "travel", note: "Flights to Haneda and back", trip: "Tokyo", at: stampOf(at(2026, 10, 20, 21, 15)) });
  spend.sort((a, b) => String(a.at).localeCompare(String(b.at)));
  files["Kinds/Spend data.md"] = note("spend", spend);

  const planned: Logged[] = [];
  const plan = (when: Date, amount: number, category: string, n: string) => planned.push({
    row: { amount, category, note: n, at: stampOf(when), line: "planned" }, t: utc("2026-11-01T17:00:00"),
    seed: `${n}\n${when.getFullYear()}-${when.getMonth() + 1}-${when.getDate()}`,
  });
  /** Twelve times, a month apart, from the first, each on the first one's day of the month or the month's last day. */
  const monthly = (first: Date, amount: number, category: string, n: string) => {
    for (let k = 0; k < 12; k++) {
      const y = first.getFullYear() + Math.floor((first.getMonth() + k) / 12), m = (first.getMonth() + k) % 12;
      plan(new Date(y, m, Math.min(first.getDate(), daysInMonth(y, m)), 9, 0), amount, category, n);
    }
  };
  monthly(at(2026, 11, 12), 15.49, "fun", "STREAMFLIX");
  monthly(at(2026, 11, 16), 38.2, "home", "METRO WATER");
  monthly(at(2026, 11, 18), 65, "home", "FASTNET INTERNET");
  monthly(at(2026, 11, 25), 45, "home", "BRIGHT MOBILE");
  monthly(at(2026, 12, 1), 1450, "home", "OAKWOOD APARTMENTS");
  monthly(at(2026, 12, 4), 95, "home", "CITY POWER & LIGHT");
  monthly(at(2026, 12, 5), 10.99, "fun", "TUNEBOX MUSIC");
  monthly(at(2026, 12, 10), 39, "fun", "PEAK FITNESS");
  plan(at(2026, 12, 15), 612, "transport", "SHIELD AUTO INSURANCE");
  plan(at(2027, 6, 15), 612, "transport", "SHIELD AUTO INSURANCE");
  plan(at(2026, 12, 28), 180, "transport", "STATE DMV REGISTRATION");
  plan(at(2027, 2, 9), 14.99, "other", "NAMEHOST DOMAIN");
  plan(at(2027, 3, 1), 99.99, "other", "CLOUDVAULT STORAGE");
  const tripCost = (when: Date, amount: number, n: string) => planned.push({
    row: { amount, category: "travel", note: n, trip: "Tokyo", at: stampOf(when), line: "planned" }, t: utc("2026-11-02T19:30:00"),
    seed: `Tokyo\n${n}\n${ymd(when)}`,
  });
  tripCost(at(2027, 3, 1, 9, 0), 330, "JR Pass, 7 days");
  tripCost(at(2027, 3, 14, 15, 0), 780, "Hotel in Shinjuku");
  for (let d = 15; d <= 20; d++) tripCost(at(2027, 3, d, 9, 0), 90, "Food and getting around");
  tripCost(at(2027, 3, 18, 19, 0), 40, "teamLab Planets");
  logs("Kinds/Spend data/log", "spend", planned);

  const bank = ([
    [2, "OAKWOOD APARTMENTS", "-1450.00"], [2, "PAYROLL ACME CO", "3120.55"], [3, "GREENLEAF MARKET", "-86.42"],
    [4, "CITY POWER & LIGHT", "-92.40"], [5, "TUNEBOX MUSIC", "-10.99"], [6, "BLUE DOOR CAFE", "-6.75"],
    [9, "TRATTORIA ROMA", "-48.00"], [10, "GREENLEAF MARKET", "-112.30"], [10, "PEAK FITNESS", "-39.00"],
    [12, "STREAMFLIX", "-17.99"], [13, "CITYPARK GARAGE", "-18.00"], [14, "FUEL STOP 42", "-44.10"],
    [16, "METRO WATER", "-38.20"], [16, "GREENLEAF MARKET", "-64.18"], [16, "PAYROLL ACME CO", "3120.55"],
    [17, "BLUE DOOR CAFE", "-4.50"],
  ] as const).map(([d, n, amount]) => {
    const when = at(2026, 11, d);
    return `${pad(when.getMonth() + 1)}/${pad(when.getDate())}/${when.getFullYear()},${n},${amount}`;
  });
  files[`Inbox/Bank/Checking ${ymd(day).slice(0, 7)}.csv`] = `${["Posted Date,Description,Amount", ...bank].join("\n")}\n`;

  // ---- Renewal --------------------------------------------------------------------------------
  const done = ([["Renew library card", [2026, 10, 15], "at the front desk", [2026, 10, 3, 17, 20]], ["Car inspection", [2026, 10, 31], "Main St garage", [2026, 10, 20, 8, 45]]] as const)
    .map(([what, [y, m, d], how, [ay, am, ad, h, mi]]) => ({ what, due: ymd(at(y, m, d)), how, at: stampOf(at(ay, am, ad, h, mi)) }));
  files["Kinds/Renewal data.md"] = note("renewal", done);
  const renewals = ([
    ["Benefits open enrolment", [2026, 11, 30], "HR portal", [2026, 11, 16]],
    ["Renew home insurance", [2026, 12, 15], "call the broker", [2026, 11, 20]],
    ["Renew car registration", [2026, 12, 31], "online at the DMV", [2026, 12, 1]],
    ["Renew passport", [2027, 3, 14], "post office, with two photos", [2027, 1, 13]],
    ["Renew driving licence", [2027, 6, 2], "DMV appointment", [2027, 4, 2]],
  ] as const).map(([what, [y, m, d], how, [sy, sm, sd]]) => {
    const due = ymd(at(y, m, d));
    return { row: { what, due, how, at: stampOf(at(sy, sm, sd)), line: "planned" }, t: utc("2026-11-01T17:05:00"), seed: `${what}\n${due}` };
  });
  logs("Kinds/Renewal data/log", "renewal", renewals);

  // ---- Dose -----------------------------------------------------------------------------------
  const doses: Row[] = [];
  const missed: Logged[] = [];
  const minute = (d: number, k: number) => (d * 7 + k * 13) % 30;
  // Authored by the reference days, `month-day`: the doses missed, the notes, the late one.
  const missA = new Set(["11-3", "11-12"]);
  const missB = new Set(["10-28", "11-8", "11-14"]);
  const notes: Record<string, string> = { "11-9 B 8": "dizzy for an hour after", "11-15 A 8": "took it with food" };
  doses.push({ med: "Medication A", refill: 30, at: stampOf(at(2026, 10, 24, 10, 0)) });
  doses.push({ med: "Medication B", refill: 56, at: stampOf(at(2026, 10, 24, 10, 5)) });
  for (let k = 25; k >= 1; k--) {
    const authored = new Date(ry, rm - 1, rd - k);
    const was = `${authored.getMonth() + 1}-${authored.getDate()}`;
    const day = at(ry, rm, rd - k);
    const [y, m, d] = [day.getFullYear(), day.getMonth() + 1, day.getDate()];
    const key = `${m}-${d}`;
    const add = (med: string, h: number, n: number) => {
      const late = med === "Medication A" && was === "11-6";
      const row: Row = { med, at: stampOf(new Date(y, m - 1, d, late ? 10 : h, late ? 40 : minute(d, n))) };
      const said = notes[`${was} ${med.slice(-1)} ${h}`];
      if (said) row.note = said;
      doses.push(row);
    };
    const skip = (med: string, h: number) => missed.push({
      row: { med, at: stampOf(new Date(y, m - 1, d, h, 0)), line: "dismissed" },
      t: new Date(Date.UTC(y, m - 1, d, h + 14)).toISOString().slice(0, 19), seed: `${med}\n${key}\n${h}`,
    });
    if (missA.has(was)) skip("Medication A", 8);
    else add("Medication A", 8, 0);
    add("Medication B", 8, 1);
    if (missB.has(was)) skip("Medication B", 20);
    else add("Medication B", 20, 2);
  }
  doses.push({ med: "Medication A", refill: 30, at: stampOf(at(2026, 11, 16, 17, 30)) });
  doses.sort((a, b) => String(a.at).localeCompare(String(b.at)));
  files["Kinds/Dose data.md"] = note("dose", doses);
  logs("Kinds/Dose data/log", "dose", missed);

  // ---- Measurement ----------------------------------------------------------------------------
  // Ninety days of a person taking their numbers, all of them made up: a weigh-in each morning, the
  // hours slept on most mornings, and blood pressure on Monday and Thursday mornings (its systolic,
  // diastolic and the cuff's pulse, at one time). Then this month's export of the phone's health
  // data, which holds most of the same readings as the devices took them, a few more, the day's step
  // counts and a failed reading.
  const measured: Row[] = [];
  const DAY0 = [2026, 8, 20] as const;
  const kg = (k: number) => Math.round((82.6 - (2.8 * k) / 89 + [0.3, -0.2, 0.1, -0.3, 0.2, 0, -0.1][k % 7]) * 10) / 10;
  // Sleep slips in the last ten days: the one measure moving the wrong way.
  const slept = (k: number) => Math.round((7.1 - (k >= 81 ? 0.6 : 0) + [0.5, -0.7, 0.3, -0.4, 0.8, 0.1, -0.2][k % 7]) * 10) / 10;
  const pressure = (k: number, j: number) => [
    Math.round(135 - (7 * k) / 89 + [4, -3, 1, 6, -2, 0][j % 6]),
    Math.round(86 - (4 * k) / 89 + [2, -2, 0, 3, -1, 1][j % 6]),
    Math.round(71 - (3 * k) / 89 + [1, -2, 3, 0, -1][j % 5]),
  ];
  const said: Record<string, string> = { "weight 74": "after a weekend away", "systolic 70": "after coffee", "sleep 57": "late flight home", "sleep 84": "forgot to wear the watch" };
  const take = (what: string, value: number, k: number, h: number, mi: number) => {
    const row: Row = { what, value, at: stampOf(at(DAY0[0], DAY0[1], DAY0[2] + k, h, mi)) };
    if (said[`${what} ${k}`]) row.note = said[`${what} ${k}`];
    measured.push(row);
  };
  let sitting = 0;
  const sittings: [number, number][] = [];
  for (let k = 0; k < 90; k++) {
    const weekday = new Date(DAY0[0], DAY0[1] - 1, DAY0[2] + k).getDay();
    if (k % 6 !== 4) take("sleep", slept(k), k, 6, 55 + (k % 4));
    take("weight", kg(k), k, 7, 15 + ((k * 7) % 10));
    if (weekday === 1 || weekday === 4) {
      const [s, d, p] = pressure(k, sitting);
      for (const [what, value] of [["systolic", s], ["diastolic", d], ["pulse", p]] as const) take(what, value, k, 7, 40);
      sittings.push([k, sitting++]);
    }
  }
  files["Kinds/Measurement data.md"] = note("measurement", measured);

  // The export: from the 9th (k = 81) to this morning (k = 90), as each device wrote it.
  const exported: string[] = [];
  const reading = (k: number, h: number, mi: number, type: string, value: number | string, unit: string, source: string) => {
    const when = at(DAY0[0], DAY0[1], DAY0[2] + k, h, mi);
    exported.push(`${ymd(when)}T${pad(when.getHours())}:${pad(when.getMinutes())},${type},${value},${unit},${source}`);
  };
  for (let k = 81; k <= 90; k++) {
    if (k !== 84) reading(k, 6, 50, "Sleep", (slept(k) + 0.03).toFixed(2), "hr", "Watch");
    reading(k, 7, 12 + (k % 5), "Weight", (kg(k) + 0.04).toFixed(2), "kg", "Scale");
    const cuff = sittings.find(([day]) => day === k);
    if (cuff) for (const [type, value, unit] of [["Systolic", "mmHg"], ["Diastolic", "mmHg"], ["Pulse", "count/min"]].map(([t, u], i) => [t, pressure(k, cuff[1])[i], u] as const)) reading(k, 7, 38, type, value, unit, "BP cuff");
    // Sunday evening: a failed reading, then one taken again, which nobody typed.
    if (k === 87) {
      for (const type of ["Systolic", "Diastolic", "Pulse"]) reading(k, 21, 2, type, 0, type === "Pulse" ? "count/min" : "mmHg", "BP cuff");
      for (const [type, value] of [["Systolic", 141], ["Diastolic", 91], ["Pulse", 76]] as const) reading(k, 21, 5, type, value, type === "Pulse" ? "count/min" : "mmHg", "BP cuff");
    }
    if (k < 90) reading(k, 23, 59, "Steps", 6200 + ((k * 1337) % 3100), "count", "Phone");
  }
  files[`Inbox/Health/Health export ${ymd(day).slice(0, 7)}.csv`] = `${["Date,Type,Value,Unit,Source", ...exported].join("\n")}\n`;

  // ---- Trade ----------------------------------------------------------------------------------
  // Twenty months of made-up buys and sells, long only, at made-up prices; a plan of five VTI a
  // month, whose tranche of the 16th nothing logged has filled; and this month's export from the
  // broker, with a dividend and interest, and a sell of MSFT bought before any of this was logged.
  const trades = ([
    [2025, 3, 10, 10, 5, "VTI", "buy", 20, 255.1], [2025, 6, 2, 9, 45, "VTI", "buy", 15, 268.4],
    [2025, 9, 15, 11, 20, "AAPL", "buy", 10, 225], [2025, 11, 20, 14, 10, "AAPL", "sell", 5, 241.5],
    [2026, 2, 3, 10, 0, "VTI", "buy", 10, 289.75], [2026, 5, 12, 9, 50, "QQQ", "buy", 6, 512.3],
    [2026, 8, 18, 15, 30, "VTI", "sell", 10, 304.2], [2026, 10, 1, 10, 30, "SPY", "buy", 4, 618.9],
    [2026, 11, 2, 10, 15, "VTI", "buy", 5, 310], [2026, 11, 9, 9, 40, "QQQ", "buy", 4, 560],
  ] as const).map(([y, m, d, h, mi, symbol, side, shares, price]): Row => ({ symbol, side, shares, price, at: stampOf(at(y, m, d, h, mi)) }));
  trades[8].note = "the plan's first tranche";
  files["Kinds/Trade data.md"] = note("trade", trades);
  const tranches = ([[2026, 11, 16], [2026, 12, 1], [2027, 1, 4], [2027, 2, 1], [2027, 3, 1]] as const).map(([y, m, d]) => {
    const when = at(y, m, d, 9, 30);
    return { row: { symbol: "VTI", side: "buy", shares: 5, price: 310, at: stampOf(when), line: "planned" }, t: utc("2026-10-25T17:00:00"), seed: `VTI\n${ymd(when)}` };
  });
  logs("Kinds/Trade data/log", "trade", tranches);
  const broker = ([
    [2, "Buy", "VTI", "5", "310.00", "-1550.00"], [5, "Dividend", "VTI", "", "", "41.20"], [9, "Buy", "QQQ", "4", "560.00", "-2240.00"],
    [12, "Sell", "MSFT", "4", "505.00", "2020.00"], [16, "Buy", "VTI", "5", "312.40", "-1562.00"], [17, "Interest", "", "", "", "0.84"],
  ] as const).map(([d, action, symbol, quantity, price, amount]) => {
    const when = at(2026, 11, d);
    return `${pad(when.getMonth() + 1)}/${pad(when.getDate())}/${when.getFullYear()},${action},${symbol},${quantity},${price},${amount}`;
  });
  files[`Inbox/Broker/Brokerage ${ymd(day).slice(0, 7)}.csv`] = `${["Trade Date,Action,Symbol,Quantity,Price,Amount", ...broker].join("\n")}\n`;

  // ---- Chore ----------------------------------------------------------------------------------
  // A household of two on a weekly rota since the week of Oct 26, kept up but for last week's bins;
  // the dishes and the shopping as they come; and the upkeep of a year, the smoke alarms overdue.
  const choresDone: Row[] = [];
  const turns: { row: Row; doneBy?: Row }[] = [];
  const rota = [["Take the bins out", "Sam", "outside", 3, 20, 0], ["Clean the bathroom", "Alex", "rooms", 5, 10, 0], ["Vacuum the house", "Sam", "rooms", 5, 11, 0], ["Do the laundry", "Alex", "laundry", 6, 10, 0]] as const;
  const ROTA_FROM = [2026, 10, 26] as const;
  const shown = (y: number, m: number, d: number, h: number, mi: number) => stampOf(at(y, m, d, h, mi));
  for (let week = 0; week < 18; week++) {
    for (const [task, who, area, dayOfWeek, h, mi] of rota) {
      const d = ROTA_FROM[2] + week * 7 + dayOfWeek;
      const authored = new Date(ROTA_FROM[0], ROTA_FROM[1] - 1, d, h, mi);
      if (authored > new Date(2027, 1, 28, 23, 59)) continue;
      const row: Row = { task, who, area, at: shown(ROTA_FROM[0], ROTA_FROM[1], d, h, mi) };
      const past = authored < new Date(ry, rm - 1, rd, 12, 0);
      const skipped = task === "Take the bins out" && authored.getMonth() === 10 && authored.getDate() === 12;
      if (past && !skipped) {
        const by = task === "Vacuum the house" && authored.getDate() === 14 ? "Alex" : who;
        const done: Row = { task, who: by, area, at: shown(ROTA_FROM[0], ROTA_FROM[1], d, h, mi + 20 + ((week * 13) % 30)) };
        choresDone.push(done);
        turns.push({ row, doneBy: done });
      } else turns.push({ row });
    }
  }
  for (let d = 26; d <= 48; d++) {
    choresDone.push({ task: "Wash the dishes", who: d % 2 ? "Sam" : "Alex", area: "kitchen", at: shown(2026, 10, d, 20, 40) });
    if (new Date(2026, 9, d).getDay() === 6) choresDone.push({ task: "Groceries", who: "Alex", area: "kitchen", at: shown(2026, 10, d, 15, 10) });
  }
  const upkeep = (task: string, who: string, plans: [number, number, number, number][], done?: [number, number, number, number, number]) => {
    const did: Row | undefined = done && { task, who, area: "upkeep", at: shown(...done) };
    if (did) choresDone.push(did);
    for (const [y, m, d, h] of plans) {
      const row: Row = { task, who, area: "upkeep", at: shown(y, m, d, h, 0) };
      turns.push({ row, ...(did && done![1] === m && done![2] === d && { doneBy: did }) });
    }
  };
  upkeep("Test the smoke alarms", "Alex", [[2026, 11, 8, 10], [2027, 11, 7, 10]]);
  upkeep("Clean the gutters", "Alex", [[2026, 11, 14, 10], [2027, 4, 17, 10]], [2026, 11, 14, 13, 30]);
  upkeep("Replace the furnace filter", "Sam", [[2026, 12, 12, 10], [2027, 3, 13, 10], [2027, 6, 12, 10], [2027, 9, 11, 10]], [2026, 9, 13, 10, 30]);
  upkeep("Car service", "Sam", [[2027, 1, 23, 9], [2027, 7, 24, 9]], [2026, 7, 25, 9, 15]);
  upkeep("Flush the water heater", "Alex", [[2027, 2, 20, 10]]);
  choresDone.sort((a, b) => String(a.at).localeCompare(String(b.at)));
  files["Kinds/Chore data.md"] = note("chore", choresDone);
  // A turn done points at the row that did it, by the id the data note gives that row.
  const ids = baseIds(choresDone);
  const doneIds = new Map(choresDone.map((r, i) => [r, ids[i]]));
  logs("Kinds/Chore data/log", "chore", turns.map(({ row, doneBy }) => ({
    row: { ...row, line: "planned", ...(doneBy && { matched: doneIds.get(doneBy)! }) }, t: utc("2026-10-25T18:00:00"), seed: `${row.task}\n${row.at}`,
  })));

  // ---- Trip planner ---------------------------------------------------------------------------
  const ics = (d: Date, time?: string) => `${ymd(d).replace(/-/g, "")}${time ?? ""}`;
  const events = ([
    ["flight-out", [14, "T104000"], [14, "T143500"], "Flight to Tokyo", "Haneda Airport", "Check in online the day before."],
    ["hotel", [15], [20], "Hotel in Shinjuku", "3-1 Nishishinjuku"],
    ["market", [16, "T073000"], [16, "T093000"], "Breakfast at Tsukiji outer market", "Tsukiji"],
    ["kamakura", [17, "T090000"], [17, "T170000"], "Day trip to Kamakura", "Kamakura Station"],
    ["teamlab", [18, "T190000"], [18, "T210000"], "teamLab Planets", "Toyosu"],
    ["flight-home", [20, "T111500"], [20, "T154500"], "Flight home", "Haneda Airport"],
  ] as const).map(([uid, [sd, st], [ed, et], summary, location, description]) => [
    "BEGIN:VEVENT", `UID:${uid}@trip`, `DTSTAMP:${utc("2026-11-01T12:00:00").replace(/[-:]/g, "")}Z`,
    st ? `DTSTART:${ics(at(2027, 3, sd), st)}` : `DTSTART;VALUE=DATE:${ics(at(2027, 3, sd))}`,
    et ? `DTEND:${ics(at(2027, 3, ed), et)}` : `DTEND;VALUE=DATE:${ics(at(2027, 3, ed))}`,
    `SUMMARY:${summary}`, `LOCATION:${location}`, ...(description ? [`DESCRIPTION:${description}`] : []), "END:VEVENT",
  ].join("\n"));
  files["Trips/Tokyo.ics"] = `${["BEGIN:VCALENDAR", "VERSION:2.0", "PRODID:-//Trip planner//Tokyo//EN", ...events, "END:VCALENDAR"].join("\n")}\n`;
  return { files, departs: ymd(at(2027, 3, 14)), returns: ymd(at(2027, 3, 20)) };
}

/** A Trip planner note's text with its `departs:` and `returns:` lines set to the days given. */
export function departed(text: string, departs: string, returns: string): string {
  return text.replace(/^departs: .*$/m, `departs: ${departs}`).replace(/^returns: .*$/m, `returns: ${returns}`);
}

/** Writes the samples for `day` into a gallery folder, taking out the sample logs and bank exports of another day first. */
export function writeSamples(folder: string, day: Date): string[] {
  const { files, departs, returns } = sampleFiles(day);
  for (const kind of ["Spend", "Renewal", "Dose", "Trade", "Chore"]) {
    const logs = join(folder, `Kinds/${kind} data/log`);
    for (const f of safeList(logs)) if (/^sample-\d{4}-\d{2}\.jsonl$/.test(f)) rmSync(join(logs, f));
  }
  for (const f of safeList(join(folder, "Inbox/Bank"))) if (/^Checking \d{4}-\d{2}\.csv$/.test(f)) rmSync(join(folder, "Inbox/Bank", f));
  for (const f of safeList(join(folder, "Inbox/Health"))) if (/^Health export \d{4}-\d{2}\.csv$/.test(f)) rmSync(join(folder, "Inbox/Health", f));
  for (const f of safeList(join(folder, "Inbox/Broker"))) if (/^Brokerage \d{4}-\d{2}\.csv$/.test(f)) rmSync(join(folder, "Inbox/Broker", f));
  for (const [path, text] of Object.entries(files)) {
    mkdirSync(join(folder, path, ".."), { recursive: true });
    writeFileSync(join(folder, path), text);
  }
  const trip = join(folder, "Apps/Trip planner.md");
  writeFileSync(trip, departed(readFileSync(trip, "utf8"), departs, returns));
  return [...Object.keys(files), "Apps/Trip planner.md"];
}

function safeList(folder: string): string[] {
  try {
    return readdirSync(folder);
  } catch {
    return [];
  }
}

if (import.meta.main) {
  const [day = "today", folder = new URL("../gallery/", import.meta.url).pathname] = process.argv.slice(2);
  const written = writeSamples(folder, dayOf(day));
  console.log(`wrote the samples for ${ymd(dayOf(day))} into ${folder}: ${written.length} files`);
}
