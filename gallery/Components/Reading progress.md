---
component: Track where I am in a book, on the book's own note
for: Books/
panels:
  - view: progress
    title: Where I am
    source: this
    field: page
    max: $this.pages
    unit: pages
  - view: text
    source: this
    compute:
      read: coalesce(page, 0)
      summary: if(pages, round(read / pages * 100) + "% read, " + (pages - read) + " pages to go", "Type the page count below")
    text: "{summary}"
  - view: form
    title: Update
    fields:
      page: number
      pages: number
      status: [to read, reading, done]
      finished: date
    save: this
---
A lens: it shows above every note in Books, so each book tracks its own page. Type the page you are on
and the bar moves; the numbers are saved as the book's own properties, which is the one thing it asks
for (changing properties of notes in Books).
