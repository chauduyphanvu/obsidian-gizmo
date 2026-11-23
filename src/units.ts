/**
 * Quantities: a number field that says what it measures. `amount: USD`, `weight: kg`, or
 * `{type: number, unit: steps}` for a unit Gizmo doesn't know. The unit gives the field its
 * format, lets a value be typed in another unit of the same kind (`180 lb` into kilograms,
 * `1500 jpy` into dollars at a rate the field gives), and lets formulas and totals be checked:
 * kilograms are never added to millimetres of mercury.
 */

/** A unit Gizmo knows: what it measures, and how many of the base unit of that measure one is. */
export interface UnitDef {
  /** As written in a note and shown beside a number: `kg`, `mmHg`, `USD`. */
  id: string;
  /** What it measures: `mass`, `length`, …, `money`, or the unit itself for one Gizmo doesn't know. */
  dim: string;
  /** How many of its measure's base unit one of it is; undefined for money, which converts by a rate. */
  factor?: number;
}

const PHYSICAL: Record<string, readonly [dim: string, factor: number]> = {
  kg: ["mass", 1], g: ["mass", 1e-3], mg: ["mass", 1e-6], mcg: ["mass", 1e-9], lb: ["mass", 0.45359237], oz: ["mass", 0.028349523125],
  km: ["length", 1000], m: ["length", 1], cm: ["length", 0.01], mm: ["length", 0.001], mi: ["length", 1609.344], ft: ["length", 0.3048], in: ["length", 0.0254],
  l: ["volume", 1], ml: ["volume", 1e-3], floz: ["volume", 0.0295735295625], cup: ["volume", 0.2365882365],
  h: ["time", 3600], min: ["time", 60], s: ["time", 1],
  mmHg: ["pressure", 1], kPa: ["pressure", 7.50061683],
  kcal: ["energy", 1], kJ: ["energy", 0.239005736],
  bpm: ["rate", 1],
};

const BY_LOWER = new Map(Object.keys(PHYSICAL).map((id) => [id.toLowerCase(), id]));

/** The money codes this runtime knows; a fixed few where it can't say. */
function currencies(): ReadonlySet<string> {
  try {
    return new Set((Intl as unknown as { supportedValuesOf(key: string): string[] }).supportedValuesOf("currency"));
  } catch {
    return new Set(["USD", "EUR", "GBP", "JPY", "CAD", "AUD", "CHF", "CNY", "INR", "MXN", "BRL", "KRW", "SEK", "NOK", "DKK", "NZD", "SGD", "HKD", "VND", "THB", "PLN"]);
  }
}

let known: ReadonlySet<string> | undefined;
const isCurrency = (code: string) => (known ??= currencies()).has(code);

/**
 * The unit a word names, in any case: a measure Gizmo knows (`kg`, `mmhg`), or a money code
 * (`usd`, `JPY`). Undefined for any other word.
 */
export function unitDef(word: string): UnitDef | undefined {
  const physical = BY_LOWER.get(word.toLowerCase());
  if (physical) return { id: physical, dim: PHYSICAL[physical][0], factor: PHYSICAL[physical][1] };
  const code = word.toUpperCase();
  return /^[A-Z]{3}$/.test(code) && isCurrency(code) ? { id: code, dim: "money" } : undefined;
}

/** A unit by its id as a field keeps it; one Gizmo doesn't know measures only itself. */
export function unitOf(id: string): UnitDef {
  return unitDef(id) ?? { id, dim: id };
}

/** Whether a unit's id can be shown beside a number: short text, no line break, nothing a format pattern would read. */
export function unitProblem(id: string): string | undefined {
  if (!id.trim() || id.length > 12 || /[\n\r0]/.test(id)) return `unit "${id}" must be a few letters, e.g. kg, USD or steps`;
  return undefined;
}

const moneyFormats = new Map<string, string>();

/**
 * The format a field with this unit shows in when it gives none: money as its code is written
 * here (`$0,0.00`, `¥0,0`, `0,0.00 CHF`), any other unit as the number then the unit (`81.2 kg`).
 */
export function unitFormat(id: string): string {
  const def = unitOf(id);
  if (def.dim !== "money") return `unit:${def.id}`;
  let format = moneyFormats.get(def.id);
  if (!format) {
    let symbol = def.id, decimals = 2;
    try {
      const f = new Intl.NumberFormat("en-US", { style: "currency", currency: def.id, currencyDisplay: "narrowSymbol" });
      symbol = f.formatToParts(1).find((p) => p.type === "currency")?.value ?? def.id;
      decimals = f.resolvedOptions().maximumFractionDigits ?? 2;
    } catch {
      // A code this runtime can't format reads as its code.
    }
    const number = `0,0${decimals ? `.${"0".repeat(decimals)}` : ""}`;
    // A sign made of letters (Fr., kr, the code itself) reads better as the code, after the number.
    format = /[A-Za-z0-9.]/.test(symbol) ? `${number} ${def.id}` : `${symbol}${number}`;
    moneyFormats.set(def.id, format);
  }
  return format;
}

/** A converted value as it is kept: money to its own decimals (yen none), a measure to three, or to four figures below 1, so 5 in of a km field isn't 0. */
function rounded(x: number, def: UnitDef): number {
  if (def.dim !== "money") return Number(Math.abs(x) < 1 ? x.toPrecision(4) : x.toFixed(3));
  const m = /\.(0+)/.exec(unitFormat(def.id));
  return Number(x.toFixed(m ? m[1].length : 0));
}

/** What a unit field takes besides its own unit. */
export interface FieldUnit {
  unit: string;
  /** For money: how many of each other currency one of the field's is, `{JPY: 150.2}` for a dollar field. */
  rates?: Record<string, number>;
}

/** A field whose unit another field of the row gives: that field, and the unit for each of its values. */
export interface UnitBy {
  by: string;
  units: Record<string, string>;
}

/** A value typed in one unit, as a field in another holds it; or why it can't. `rate`: how many of the typed unit one of the field's is. */
export function convert(n: number, from: UnitDef, field: FieldUnit): { value: number; rate?: number } | { error: string } {
  const to = unitOf(field.unit);
  if (from.id === to.id) return { value: n };
  if (from.dim !== to.dim) return { error: `is in ${to.id}, and ${from.id} measures something else` };
  if (from.factor !== undefined && to.factor !== undefined) return { value: rounded((n * from.factor) / to.factor, to) };
  const rate = field.rates && Object.entries(field.rates).find(([code]) => code.toUpperCase() === from.id)?.[1];
  if (typeof rate !== "number" || !(rate > 0)) return { error: `is in ${to.id}, and has no rate for ${from.id}; add rates: {${from.id}: …} to the field` };
  return { value: rounded(n / rate, to), rate };
}

/** `1500jpy`, `180lb`, `81.2kg`: a number with its unit in one word; undefined for anything else. */
export function quantityIn(word: string): { n: number; unit: UnitDef } | undefined {
  const m = /^([+-]?(?:\d+\.?\d*|\.\d+))([A-Za-z]{1,5})$/.exec(word);
  const unit = m ? unitDef(m[2]) : undefined;
  return m && unit ? { n: Number(m[1]), unit } : undefined;
}

/** What a typed quantity was before it was converted, as its row keeps it: `1500 JPY @150.2`. */
export function typedAs(n: number, unit: UnitDef, rate: number | undefined): string {
  return `${n} ${unit.id}${rate === undefined ? "" : ` @${rate}`}`;
}

/** The field a converted value's original is kept in, beside the field itself. */
export const asField = (field: string) => `${field}_as`;
