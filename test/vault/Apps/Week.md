---
app: What's on this week, and log what I did
panels:
  - view: list
    title: Next 7 days
    source: Calendar/family.ics
    where: {start: next 7 days}
    sort: start
    item: "{start} · {summary}"
    action: Done
    save: done
    row:
      what: "{summary}"
      planned: "{start}"
    notify: Logged {summary}
  - view: form
    title: Log something else
    save: done
    label: Log it
    fields:
      what: text
  - view: list
    title: Done this week
    source: done
    where: {at: this week}
    sort: -at
    item: "{at} · {what}"
---
The agenda reads Calendar/family.ics in the vault. Done on an item logs it; the form logs anything
that was never on the calendar.
