---
app: Log when I take my meds
panels:
  - view: button
    label: Took meds
    save: doses
    append: Daily.md
    line: "- Took meds {time}"
    notify: Logged
    shortcut: took-meds
  - view: number
    title: Doses today
    source: doses
    where: {at: today}
    agg: count
    pin: status
---
