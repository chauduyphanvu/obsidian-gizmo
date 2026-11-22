---
kind: spend
shortcut: spend
fields:
  amount: {type: number, label: Spent, format: "$0,0.00"}
  category: [food, home, transport, fun, travel, other]
  note: text
  local: number
  trip: text
import:
  bank: {folder: Inbox/Bank, at: Posted Date, amount: "-Amount", note: Description, where: {Amount: "< 0"}}
match:
  - {amount: exact, at: 3d}
  - {note: contains, amount: 20%, at: 3d}
---
Every amount I spend, in dollars, for any app to read and add to. Budget, Bills and renewals and
Trip planner all save here, so a trip's expenses and every bill count in the month's total. `local`
is the amount in a trip's own currency and `trip` names the trip; both stay empty for spending at
home. Type `spend 14.5 food lunch` in Gizmo: Do… to add a row without opening anything, and end it
with a day still to come (`spend 1450 home "OAKWOOD APARTMENTS" @2026-12-01`) to plan a bill.

Drop your bank's CSV export into Inbox/Bank (or run Gizmo: Import rows into a kind…): each row
of money out comes in as the bank's, as a positive amount, and money in, such as a pay cheque,
stays out. This note shows a card that pairs each row with what you logged, the same amount within
three days. Accept what is yours and Not mine what isn't. A bill you planned is settled by the
charge that pays it: the same amount within three days, or up to a fifth more or less when the
charge's name holds the bill's, so name a bill as your bank does. It asks to read the files in
Inbox/Bank; the rows are kept in Spend data.
