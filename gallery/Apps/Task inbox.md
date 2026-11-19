---
app: Capture tasks and tick them off wherever they live in my notes
data:
  work:
    source: tasks
    from: Tasks
panels:
  - view: form
    title: Add to the inbox
    fields: {task: text}
    append: Tasks/Inbox
    line: "- [ ] {task}"
    label: Add
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
    where: {done: false, due: this week}
    label: open tasks
  - view: list
    title: Done
    source: work
    where: {done: true}
    sort: -due
    limit: 10
    item: "{text} · {name}"
---
Every checkbox in the notes under Tasks, with undated ones first. New tasks are added as a line in
Tasks/Inbox, and ticking one in the table ticks it in its note; it asks to read the notes in Tasks,
tick tasks in them, and add lines to Tasks/Inbox.md.
