---
app: Errands to run, added here or by another app
panels:
  - view: form
    title: Add an errand
    fields: {errand: text}
    save: errands
    label: Add
    shortcut: add
  - view: list
    title: To do
    source: errands
    sort: -at
    item: "{errand}"
---
Add an errand, or let another app add one: Calls adds a call-back here. Its copied link, with
`&errand=…` on the end, adds one from outside Obsidian. It asks for nothing.
