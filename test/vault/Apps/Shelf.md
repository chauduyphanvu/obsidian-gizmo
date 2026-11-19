---
app: My books by status, from the same base Obsidian shows
data:
  shelf:
    source: "[[Books.base]]"
    fields:
      status: [to read, reading, done]
panels:
  - view: table
    title: Shelf
    source: shelf
    sort: name
    columns: [name, status, finished]
    edit: [status]
  - view: list
    title: By status
    source: shelf
    group: status
    item: "{status} · {count}"
---
The books that Books.base picks, the same ones its view in Obsidian lists. Set a book's status here
and the base sees it too.
