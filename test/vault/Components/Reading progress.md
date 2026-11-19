---
component: Track where I am in this book
for: Books/
panels:
  - view: progress
    title: Where I am
    source: this
    field: page
    max: $this.pages
    unit: pages
  - view: form
    title: Update
    fields:
      page: number
      pages: number
      status: [to read, reading, done]
    save: this
---
A lens: shown above every note in Books. Type the page you're on and the bar moves; the numbers
are saved as the book's own properties.
