---
app: See what's open across my projects and tick things off
data:
  work:
    source: tasks
    from: Tasks
panels:
  - view: table
    title: Open
    source: work
    where: {done: false}
    sort: due
    columns: [text, name, due, done]
    edit: [done]
  - view: number
    title: Due this week
    source: work
    where: {done: false, due: next 7 days}
    label: open tasks due in the next 7 days
  - view: list
    title: Done
    source: work
    where: {done: true}
    item: "{text} · {name}"
---
Every checkbox in the notes under Tasks. Tick one in the table and it is ticked in its note.
