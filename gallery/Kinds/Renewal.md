---
kind: renewal
shortcut: renewal
fields:
  what: text
  due: {type: date, label: Due}
  how: text
match: {what: exact, at: 365d}
---
Every deadline I must act on before it passes: a passport, a driving licence, a car's registration,
an insurance policy, a benefits enrolment. Each one is a planned row: `due` is the deadline, and the
row's own time is the day to start on it, so Next asks "did it happen?" in time, not on the day it
lapses. Type `renewal "Renew passport" 2027-03-14 @2027-01-13` in Gizmo: Do… to plan one: due on
March 14, start in mid January. When it is done, answer Next, or log the same `what` again
(`renewal "Renew passport"`): that settles the planned row. What a renewal costs is money, and goes in
Spend as a planned bill, so Budget counts it in its month. The rows are kept in Renewal data.
