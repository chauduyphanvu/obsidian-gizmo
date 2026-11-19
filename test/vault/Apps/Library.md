---
app: Find books on Open Library, read about one, and keep the ones I want
inputs:
  q: text
data:
  shelf:
    source: notes
    from: Books
    fields:
      status: [to read, reading, done]
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
  - view: table
    title: My shelf
    source: shelf
    sort: name
    columns: [name, author, status, finished]
    edit: [status]
---
Type a title or an author to search Open Library (no key needed). Pick a result to read about it;
Add saves it as a note in Books, where the shelf lets you set how far along you are.
