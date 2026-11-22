---
kind: measurement
shortcut: measure
fields:
  what: [weight, sleep, systolic, diastolic, pulse]
  value: number
  note: text
import:
  health: {folder: Inbox/Health, at: Date, what: Type, value: Value, where: {Type: "!= Steps", Value: "> 0"}}
match: {what: exact, value: 0.1, at: 0d}
---
Each number I measure about myself: my weight in kilograms, the hours I slept, my blood pressure and
my pulse, with a note when something was off (after coffee, a late night). One row is one number, so
a blood pressure reading is two rows taken together, its systolic and its diastolic, and the cuff's
pulse a third; Vitals shows them side by side by the morning or evening they were taken. Type
`measure weight 79.8` in Gizmo: Do… to add one without opening anything.

Export your phone's health data as CSV (one row per reading, with its Date, Type and Value) into
Inbox/Health, or run Gizmo: Import rows into a kind…: each reading comes in as the device's, and the
step counts and failed readings (a value of 0) stay out. This note shows a card that pairs each
reading with one you typed, the same measure on the same day within 0.1, so nothing counts twice.
Accept what is yours and Not mine what isn't. Put the measures your export names in `what` if they
differ. It asks to read the files in Inbox/Health; the rows are kept in Measurement data.
