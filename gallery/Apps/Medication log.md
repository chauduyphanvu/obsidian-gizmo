---
app: Take each dose on time, catch the ones I miss, refill before I run out, and show my doctor how it went
data:
  doses:
    source: "[[Dose]]"
    where: {refill: ""}
  dose_rows:
    source: doses
  today:
    source: "[[Dose]]"
    lines: [logged, planned, dismissed]
    where: {at: today, refill: ""}
    compute:
      status: 'if(line == "dismissed", "missed", if(line == "planned", if(at < now(), "not taken yet", "due"), "taken"))'
  due:
    source: "[[Dose]]"
    lines: planned
    compute:
      ahead: at > now()
    where: {ahead: true, matched: ""}
    sort: at
  bymed:
    source: "[[Dose]]"
    sort: med
  supply:
    source: bymed
  month:
    source: "[[Dose]]"
    lines: [logged, planned, dismissed]
    compute:
      recent: days(at, today()) < 30
      taken: if(line, 0, 1)
      missed: if(line, 1, 0)
    where: {at: past, refill: "", recent: true}
    sort: med
  month_rows:
    source: month
tabs:
  Today:
    - view: button
      label: Took Medication A
      save: "[[Dose]]"
      row: {med: Medication A}
      notify: Logged Medication A
      shortcut: took-meds
      alias: meds
    - view: button
      label: Took Medication B
      save: "[[Dose]]"
      row: {med: Medication B}
      notify: Logged Medication B
      shortcut: took-b
      alias: medb
    - view: number
      title: Doses today
      source: dose_rows
      where: {at: today}
      agg: count
      pin: status
      shortcut: doses-today
    - view: text
      title: Next dose
      source: due
      text: "{med}, {at}"
      format: {at: relative}
      empty: No dose planned yet.
    - view: number
      title: Days on time
      source: expect
      where: {rule: morning-dose, met: true}
      group: at
      per: day
      agg: streak
      unit: days
    - view: table
      title: Today's doses
      source: today
      sort: at
      columns: [at, med, status]
      labels: {at: When, med: Medication, status: ""}
      format: {at: time}
      empty: Nothing taken or planned today yet. To plan the schedule, type in Gizmo Do…, e.g. dose "Medication A" @every day 08:00 until 2027-02-28.
    - view: calendar
      title: My year
      source: doses
      group: at
      layout: year
      select: day
    - view: list
      title: Doses on the day I pick
      source: dose_rows
      where: {at: $day.at}
      sort: at
      item: "{med}"
  Supply:
    - view: form
      title: Picked up a refill
      save: "[[Dose]]"
      fields: [med, refill]
      label: Add refill
      alias: refill
    - view: table
      title: What I have left
      source: supply
      compute:
        change: if(refill, refill, -1)
        lately: if(!refill && days(at, today()) < 14, 1, 0)
        first: prev(med) != med
        stock: if(first, change, prev(stock) + change)
        refilled: if(first, 0, prev(refilled)) + if(refill, 1, 0)
        taken14: if(first, lately, prev(taken14) + lately)
        on_hand: if(refilled > 0, max(stock, 0), "")
        a_day: round(taken14 / 14, 1)
        days_left: if(refilled > 0 && taken14 > 0, floor(max(stock, 0) / (taken14 / 14)), "")
      group: med
      columns: [med, on_hand, a_day, days_left]
      agg: last
      labels: {med: Medication, on_hand: On hand, a_day: Per day, days_left: Days left}
      format: {a_day: "0.0"}
      alert: {days_left: "<= 7"}
      empty: Add a refill with the doses you have on hand, and each dose counts it down.
  For the doctor:
    - view: number
      title: Taken as planned
      source: month
      agg: share
      of: {missed: 0}
      format: "0%"
      label: of my doses in the last 30 days
    - view: table
      title: Each medication, last 30 days
      source: month_rows
      compute:
        first: prev(med) != med
        took: if(first, taken, prev(took) + taken)
        skipped: if(first, missed, prev(skipped) + missed)
        share: round(took / (took + skipped) * 100)
      group: med
      columns: [med, took, skipped, share]
      agg: last
      labels: {med: Medication, took: Taken, skipped: Missed, share: "% taken"}
    - view: table
      title: Missed doses
      source: month_rows
      where: {missed: 1}
      sort: -at
      columns: [at, med]
      labels: {at: Planned for, med: Medication}
      format: {at: datetime}
      empty: No missed doses in the last 30 days.
    - view: table
      title: What I noted
      source: dose_rows
      compute:
        noted: len(trim(coalesce(note, ""))) > 0
      where: {noted: true, at: last 30 days}
      sort: -at
      columns: [at, med, note]
      labels: {at: When, med: Medication, note: Note}
      format: {at: date}
      empty: No notes in the last 30 days. Add one after the medication, e.g. dose "Medication B" dizzy after.
expect:
  - id: morning-dose
    every: day
    by: "10:00"
    source: doses
    where: {med: Medication A}
    say: no dose of Medication A logged by 10:00
---
For your own medication, or someone's you look after. Each dose is a row of the kind Dose; put your
medications in place of Medication A and B, there and in the two buttons. Press a button when a dose
is taken, or type `meds` in Gizmo: Do…; a hotkey or the link "Copy link to an app shortcut" gives
for Took Medication A does the same with the app closed, and today's count sits in the status bar
(its link answers with the count, for a phone shortcut). Plan the schedule once: `dose "Medication
A" @every day 08:00 until 2027-02-28` plans one a day at 08:00. A dose taken the same day settles
the planned one nearest in time, and Gizmo: Next asks about a planned dose whose time passed with
none taken: Enter says it was taken then, x says it was missed. `expect` also wants a dose of
Medication A by 10:00 each day and tells you when none came (on your phone too, when gizmod runs);
Days on time counts the days in a row it came. On a day with Medication A's dose planned, Next asks
about it once: the planned dose's ask stands in for that rule's. Supply counts each medication down
from the refills you add, in doses, at the rate taken over the last two weeks, and tells you when
one has a week or less left. For the doctor sums up the last 30 days: the share taken as planned,
each medication, the doses missed and what you noted. It asks to read and change the rows of Dose,
and for the answer of Doses today.

When someone else gives doses too, a carer or a partner with a vault of their own: share the kind
Dose. Remove the `#` before `share` in the Dose note and run Gizmo: Invite to a kind there; it makes
the key the first time and gives a link to send, privately. Opening it in Obsidian shows them the
kind and asks before it changes anything. Then each dose either of you logs goes to the other,
sealed, through ntfy.sh, and this app counts both. For a carer without Gizmo, Gizmo: Make a guest
page, in the Dose note, makes one page with the form, to open on a phone: it adds doses, it can't
read any, and its doses arrive with their name. Remove them on the automation map when the care ends.
