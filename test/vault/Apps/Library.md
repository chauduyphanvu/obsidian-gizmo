---
app: Find books on Open Library, keep the ones I want, and track how many I finish this year
inputs:
  q: text
data:
  shelf:
    source: notes
    from: Books
    fields:
      status: [to read, reading, done]
      finished: date
panels:
  - view: list
    title: Search results
    source: https://openlibrary.org/search.json?q=$q&limit=10
    pick: docs
    item: "{title} · {author_name.0}"
    select: book
    action: Add
    save: Books/
    name: "{title}"
    row:
      title: "{title}"
      author: "{author_name.0}"
      year: "{first_publish_year}"
      status: to read
    notify: Added {title} to Books
  - view: text
    title: About this book
    text: "$book.title, by $book.author_name.0. First published in $book.first_publish_year; $book.edition_count editions."
  - view: progress
    title: Reading goal
    source: shelf
    where: {finished: this year}
    max: 24
    unit: books
    label: finished this year; set the date a book was finished on the shelf
  - view: table
    title: My shelf
    source: shelf
    sort: name
    columns: [name, author, status, finished]
    labels: {name: Book, author: Author, status: Status, finished: Finished}
    edit: [status, finished]
---
Type a title or an author to search Open Library (no key needed). Pick a result to read about it;
Add saves it as a note in Books, where the shelf lets you set how far along you are. Set the day
you finish a book and the reading goal moves (24 a year; change `max` to set your own).
