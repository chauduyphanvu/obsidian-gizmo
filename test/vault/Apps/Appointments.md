---
app: Health appointments coming up
panels:
  - view: list
    title: Coming up
    source: notes
    from: "#health/appointment"
    where: {date: upcoming}
    sort: date
    item: "{date} · {name} ({who})"
  - view: table
    title: All
    source: notes
    from: Health
    sort: -date
    columns: [name, date, who]
---
