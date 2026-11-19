---
app: Chores around the house
data:
  chores:
    source: chores
    fields:
      task: text
      room: [kitchen, bathroom, garden, everywhere]
      done: checkbox
panels:
  - view: form
    title: New chore
    save: chores
    label: Add
  - view: table
    title: To do
    source: chores
    where: {done: false}
    columns: [task, room, done]
    edit: [done]
  - view: number
    title: Done
    source: chores
    where: {done: true}
    label: chores ticked off
---
