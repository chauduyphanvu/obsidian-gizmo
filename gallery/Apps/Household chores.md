---
app: Share the chores and keep up the house, with what is due this week, what is overdue, who did what, and a year of upkeep
data:
  chores:
    source: "[[Chore]]"
  chore_rows:
    source: chores
  week:
    source: "[[Chore]]"
    lines: [logged, planned]
    where: {at: this week}
    compute:
      status: 'if(line == "planned", if(at < now(), "overdue", "to do"), "done")'
  week_rows:
    source: week
  overdue:
    source: "[[Chore]]"
    lines: planned
    where: {at: past, matched: ""}
  upkeep_plan:
    source: "[[Chore]]"
    lines: planned
    where: {area: upkeep, at: next 365 days, matched: ""}
  upkeep_plan_rows:
    source: upkeep_plan
  upkeep_done:
    source: "[[Chore]]"
    where: {area: upkeep}
    sort: at
  upkeep_done_rows:
    source: upkeep_done
  upkeep_cost:
    source: "[[Spend]]"
    compute:
      upkeep: 'startswith(note, "Upkeep: ")'
    where: {upkeep: true}
  upkeep_cost_rows:
    source: upkeep_cost
tabs:
  This week:
    - view: number
      title: Done this week
      source: chore_rows
      where: {at: this week}
      agg: count
      compare: previous
      label: chores done
    - view: number
      title: Still to do this week
      source: week_rows
      where: {status: to do}
      agg: count
      label: on the rota
    - view: number
      title: Overdue
      source: overdue
      agg: count
      label: planned, and not done
    - view: form
      title: Did a chore
      save: "[[Chore]]"
      fields: [task, who, area]
      label: Log
      shortcut: did
    - view: form
      title: Plan a chore
      save: "[[Chore]]"
      fields: [task, who, area]
      label: Plan chore
      alias: rota
    - view: table
      title: This week
      source: week
      sort: at
      columns: [at, task, who, status]
      labels: {at: When, task: Chore, who: Who, status: ""}
      format: {at: datetime}
      empty: Nothing done or planned this week yet. Plan the rota, e.g. "Take the bins out" Sam outside @every week from thu 20:00 until 2027-03-01.
    - view: table
      title: Overdue turns
      source: overdue
      sort: at
      columns: [at, task, who]
      labels: {at: Planned for, task: Chore, who: Whose turn}
      format: {at: date}
      empty: Nothing overdue.
    - view: bar
      title: Who did what this week
      source: chore_rows
      where: {at: this week}
      group: who
      agg: count
      labels: {count: Chores}
    - view: table
      title: Lately
      source: chores
      sort: -at
      limit: 15
      columns: [at, task, who]
      labels: {at: When, task: Chore, who: Who}
      format: {at: relative}
      edit: [task, who]
  Upkeep:
    - view: number
      title: Upkeep in the next 30 days
      source: upkeep_plan_rows
      where: {at: next 30 days}
      agg: count
      label: jobs planned
    - view: text
      title: Next upkeep
      source: upkeep_plan
      sort: at
      text: "{task}, {at}"
      format: {at: relative}
      empty: Nothing planned
    - view: number
      title: Upkeep paid this year
      source: upkeep_cost_rows
      where: {at: this year}
      field: amount
      agg: sum
      format: "$0,0.00"
      label: in Spend, so Budget counts it
    - view: form
      title: Plan upkeep
      save: "[[Chore]]"
      fields: [task, who]
      labels: {task: Upkeep}
      row: {task: "{task}", who: "{who}", area: upkeep}
      label: Plan upkeep
      alias: upkeep
    - view: form
      title: Paid for upkeep
      save: "[[Spend]]"
      fields:
        amount: {type: number, label: Paid, format: "$0,0.00"}
        what: text
      row: {amount: "{amount}", note: "Upkeep: {what}", category: home}
      label: Add
      alias: upkeep-paid
    - view: table
      title: Upkeep in the next 12 months
      source: upkeep_plan
      sort: at
      columns: [at, task, who]
      labels: {at: When, task: Upkeep, who: Whose turn}
      format: {at: date}
      empty: No upkeep planned. Plan it with how often, e.g. "Replace the furnace filter" Sam @every 3 months from dec 12 until 2028-01-01.
    - view: bar
      title: Upkeep each month
      source: upkeep_plan_rows
      group: at
      per: month
      agg: count
      labels: {count: Jobs}
      empty: No upkeep planned in the next 12 months.
    - view: table
      title: Last done
      source: upkeep_done_rows
      group: task
      agg: last
      columns: [task, at, who]
      labels: {task: Upkeep, at: Last done, who: Who}
      format: {at: relative}
      empty: No upkeep done yet.
    - view: table
      title: What upkeep cost
      source: upkeep_cost
      sort: -at
      columns: [at, note, amount]
      labels: {at: When, note: Paid for, amount: Paid}
      format: {at: date}
      empty: No upkeep paid yet. Add what a job cost, e.g. 24.99 furnace filter.
---
For a household that shares this vault through iCloud, Syncthing or any other sync: each phone or
computer keeps what it saves in a log of its own, so two people logging at the same moment never
overwrite each other's rows. Each chore is a row of the kind Chore; put your household in `who` there
in place of Alex and Sam. Plan the rota once, a chore with whose turn it is and how often: `"Take
the bins out" Sam outside @every week from thu 20:00 until 2027-03-01`. When it is done, by anyone,
log it on the line (`vacuum Alex`) and it settles that turn; Gizmo: Next asks about a turn whose
time passed with nothing done, and Enter says it was done then. This week shows the week's rota and
what was done, Overdue turns what is late, and Who did what the share of each.

Upkeep comes round months apart, so plan it on Upkeep with how often and from which day: the furnace
filter `"Replace the furnace filter" Sam @every 3 months from dec 12 until 2028-01-01`, the smoke
alarms `"Test the smoke alarms" Alex @every year from nov 7 until 2030-01-01`, or one time with its
day, `"Car service" Sam @jan 23` (a month and a day is the next one). Gizmo plans no next time when
one is done, so plan a few years at once. Last done says when each
was last done. What a job cost goes in Spend under Paid for upkeep, as home with its note starting
`Upkeep:`, so Budget counts it and this tab adds it up. It asks to read and change the rows of Chore
and Spend.

For a household with a vault each, not one vault in sync: share the kind Chore. Remove the `#` before
`share` in the Chore note and run Gizmo: Invite to a kind there; it makes the key the first time and
gives a link to send, privately, to the other person. Opening it in Obsidian shows them the kind and
asks before it changes anything. Then each chore either of you logs goes to the other, sealed,
through ntfy.sh, and this app shows both. For a sitter or a carer without Gizmo, Gizmo: Make a guest
page, in the Chore note, makes one page with the form, to open on a phone: it adds chores, it can't
read any, and its chores arrive with their name. Remove them on the automation map when the job ends.
