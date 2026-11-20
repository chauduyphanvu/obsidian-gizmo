---
app: Log every dose I take and keep my streak going
panels:
  - view: button
    label: Took meds
    save: doses
    notify: Dose logged
    shortcut: took-meds
  - view: number
    title: Doses today
    source: doses
    where: {at: today}
    agg: count
    pin: status
  - view: number
    title: Streak
    source: doses
    group: at
    per: day
    agg: streak
    unit: days
  - view: calendar
    title: My year
    source: doses
    group: at
    layout: year
    select: day
  - view: list
    title: Doses on the day I pick
    source: doses
    where: {at: $day.at}
    sort: at
    item: "{at}"
    format: {at: time}
---
Press the button each time you take a dose: today's count sits in the status bar, and a hotkey or
the link "Copy link to an app shortcut" gives for Took meds logs one with the app closed (a link
without the key a copied one carries asks first). It asks for
nothing, because everything is saved in the note Medication log data next to it.
