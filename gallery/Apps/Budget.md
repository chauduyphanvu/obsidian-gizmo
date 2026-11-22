---
app: Know where the month will end before it ends, with every bill and bank charge in it
limit: 2500
data:
  spend:
    source: "[[Spend]]"
  month:
    source: spend
    where: {at: this month}
  lands:
    source: "[[Spend]]"
    lines: [logged, planned]
    where: {at: this month}
  coming:
    source: "[[Spend]]"
    lines: planned
    where: {at: this month, matched: ""}
panels:
  - view: number
    title: The month lands at
    source: lands
    field: amount
    agg: sum
    label: spent so far, and the bills still to come
    alert: "> $this.limit"
    shortcut: lands
  - view: progress
    title: Against my limit
    source: lands
    field: amount
    agg: sum
    max: $this.limit
    format: "$0,0"
  - view: number
    title: Spent so far
    source: month
    field: amount
    agg: sum
    compare: previous
    shortcut: spent
  - view: number
    title: Still to come
    source: coming
    field: amount
    agg: sum
    label: in bills planned this month
  - view: form
    title: Spent something
    save: spend
    label: Add
    fields: [amount, category, note]
  - view: table
    title: Bills still to pay this month
    source: coming
    sort: at
    columns: [note, amount]
    labels: {note: Bill, amount: Amount}
    empty: No bill left to pay this month. Plan one with a day still to come, e.g. 65 home "FASTNET INTERNET" @+30d.
  - view: reconcile
    title: Charges from the bank, not checked yet
    source: "[[Spend]]"
    empty: No charge from the bank waits. Drop its CSV export in Inbox/Bank.
  - view: bar
    title: Each week by category
    source: spend
    compute:
      food: if(category == 'food', amount, 0)
      home: if(category == 'home', amount, 0)
      transport: if(category == 'transport', amount, 0)
      fun: if(category == 'fun', amount, 0)
      travel: if(category == 'travel', amount, 0)
      other: if(coalesce(category, 'other') == 'other', amount, 0)
    where: {at: last 8 weeks}
    group: at
    per: week
    y: [food, home, transport, fun, travel, other]
    agg: sum
    stack: true
    goal: 625
    format: "$0,0"
    labels: {food: Food, home: Home, transport: Transport, fun: Fun, travel: Travel, other: Other or none}
  - view: table
    title: Recent
    source: spend
    sort: -at
    limit: 12
    columns: [at, amount, category, note]
    labels: {at: When}
    format: {at: relative}
    edit: true
---
See where the month will land before it does: what you have spent, plus every bill planned for the
rest of it (Bills and renewals plans them, or any line in Gizmo: Do… with a day still to come). You
are told when that total passes your limit, the `limit` at the top (change it there), not only once
the money is gone. Drop your bank's CSV export in Inbox/Bank and allow Spend, from the card that
asks for it here: its charges wait under Charges from the bank until you check them there, where Accept takes what is yours and Not mine sets the rest
aside; a charge that pays a planned bill settles it, even a little dearer under the same name. A
bill whose day passed with nothing paying it comes up in Gizmo: Next. To try a big purchase first,
run What if… from the tab menu and add it: the card says whether and when the alert would go on,
and nothing real changes until Keep. Fix a wrong amount or category in Recent. What you add goes
into the kind Spend, which Bills and renewals and Trip planner add to as well. It asks to read and
change the rows of Spend, and for the answers of The month lands at and Spent so far, for a phone
shortcut to read out.
