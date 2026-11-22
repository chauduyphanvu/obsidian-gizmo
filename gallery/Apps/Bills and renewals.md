---
app: Keep every bill and renewal in one place, so nothing lapses and no price rise slips by
data:
  bills:
    source: "[[Spend]]"
    lines: planned
    where: {matched: "", trip: ""}
  soon:
    source: bills
    where: {at: next 30 days}
  late:
    source: bills
    where: {at: past}
  year:
    source: "[[Spend]]"
    lines: planned
    where: {at: next 365 days, matched: "", trip: ""}
  renewals:
    source: "[[Renewal]]"
    lines: planned
    where: {matched: ""}
    compute:
      days_left: days(today(), due)
      start: date(at)
      started: at < now()
    sort: due
  renewal_rows:
    source: renewals
tabs:
  Next 30 days:
    - view: number
      title: Bills in the next 30 days
      source: soon
      field: amount
      agg: sum
      label: planned and not paid yet
    - view: number
      title: Renewals to start
      source: renewal_rows
      where: {started: true}
      label: whose day to start has come
    - view: form
      title: A bill
      save: "[[Spend]]"
      fields: [amount, note, category]
      labels: {amount: Amount, note: Bill}
      label: Plan bill
      alias: bill
    - view: form
      title: A renewal
      save: "[[Renewal]]"
      fields: [what, due, how]
      label: Plan renewal
      alias: renew
    - view: table
      title: Overdue
      source: late
      sort: at
      columns: [note, amount]
      labels: {note: Bill, amount: Amount}
      empty: No bill is overdue.
    - view: table
      title: Coming up
      source: soon
      sort: at
      columns: [note, amount]
      labels: {note: Bill, amount: Amount}
      edit: true
      empty: No bill planned in the next 30 days. Plan one with its day, e.g. 15.49 STREAMFLIX fun @+30d.
    - view: table
      title: Renewals by deadline
      source: renewals
      sort: days_left
      columns: [what, due, days_left, start, how]
      labels: {what: Renewal, due: Due, days_left: Days left, start: Start by, how: How}
      alert: {days_left: "<= 14"}
      empty: No renewal planned. Plan one with its deadline and the day to start, e.g. "Renew passport" 2027-03-14 @2027-01-13.
  A year of bills:
    - view: number
      title: The next 12 months
      source: year
      field: amount
      agg: sum
      label: in bills planned
    - view: bar
      title: Each month's bills
      source: year
      group: at
      per: month
      y: amount
      agg: sum
      format: "$0,0"
      labels: {amount: Planned}
    - view: table
      title: What each bill costs in a year
      source: year
      group: note
      columns: [note, count, amount]
      agg: sum
      sort: -amount
      labels: {note: Bill, count: Times, amount: In 12 months}
      empty: No bill planned in the next 12 months.
  Price changes:
    - view: table
      title: Charged more than planned
      source: "[[Spend]]"
      lines: planned
      compute:
        paid: settled.amount
        rise: settled.amount - amount
      where: {at: last 60 days, rise: "> 0"}
      sort: at
      group: note
      columns: [note, amount, paid, rise]
      agg: last
      labels: {note: Bill, amount: Planned, paid: Charged, rise: More by}
      format: {amount: "$0,0.00", paid: "$0,0.00", rise: "$0,0.00"}
      alert: {rise: "> 0"}
      empty: No bill in the last 60 days cost more than planned.
  Done:
    - view: table
      title: Renewed
      source: "[[Renewal]]"
      sort: -at
      columns: [at, what, how]
      labels: {at: Done, what: Renewal, how: How}
      format: {at: date}
      empty: Nothing renewed yet.
---
Every bill is a planned row of Spend, so Budget counts it in its month: plan one with its day,
`15.49 STREAMFLIX fun @2026-12-12`, or every month from that day, `@every month from 2026-12-12
until 2027-11-30`; a yearly or half-yearly one with how often, `612 transport "SHIELD AUTO INSURANCE"
@every 6 months from dec 15 until 2028-12-31`. Name a bill as your bank's statement does, so the charge that pays it settles
it, even a dearer one (up to a fifth more) under the same name; Price changes then shows the rise,
so type the new price over the bill's next one in Coming up, as each comes within 30 days. Every
renewal is a planned row of Renewal, with its deadline and the day to start on it: `"Renew
passport" 2027-03-14 @2027-01-13`. Gizmo: Next asks about a bill whose day passed with nothing
paying it, and about a renewal once its day to start has come; Renewals by deadline also tells you
when one is two weeks from it. When it is done, answer Next, or log the same renewal without a day.
A year of bills adds up the next twelve months, bill by bill, less those already paid. Price changes
compares what each bill was planned at with the charge that settled it, over the last 60 days, whatever
name the bank gave the charge. It asks to read and change the rows of Spend and Renewal.
