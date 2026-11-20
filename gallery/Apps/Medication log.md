---
app: Log every dose I take and keep my streak going
panels:
  - view: button
    label: Took meds
    save: doses
    notify: Dose logged
    shortcut: took-meds
    alias: meds
  - view: number
    title: Doses today
    source: doses
    where: {at: today}
    agg: count
    pin: status
    shortcut: doses-today
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
without the key a copied one carries asks first). The link for Doses today answers
with today's count instead, so a phone shortcut (Shortcuts' Open X-Callback URL) can ask how many
doses you've had without opening Obsidian; the first time, it asks which app the answer may go to.
That is all it asks for: everything is saved in the note Medication log data next to it.
