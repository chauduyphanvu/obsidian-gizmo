---
app: Find books on Open Library and keep the ones I want on my shelf
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
    title: Search Open Library
    source: https://openlibrary.org/search.json?q=$q&limit=10&fields=key,title,author_name,first_publish_year,edition_count,number_of_pages_median,cover_i
    pick: docs
    item: "{title} · {author_name.0} ({first_publish_year})"
    select: book
    action: Add
    save: Books/
    name: "{title}"
    row:
      title: "{title}"
      author: "{author_name.0}"
      year: "{first_publish_year}"
      pages: "{number_of_pages_median}"
      cover: "{cover_i}"
      status: to read
    notify: Added {title} to Books
  - view: text
    title: About the pick
    text: "$book.title, by $book.author_name.0, first published in $book.first_publish_year. $book.edition_count editions."
  - view: number
    title: Read this year
    source: shelf
    where: {finished: this year}
    label: books finished
  - view: table
    title: My shelf
    source: shelf
    compute:
      picture: if(cover, "https://covers.openlibrary.org/b/id/" + cover + "-M.jpg", "")
    sort: name
    columns: [picture, name, author, status, finished]
    cells: {picture: image}
    layout: cards
    edit: [status, finished]
---
Type a title or an author to search Open Library (no key needed), pick a result to read about it, and Add
it to the shelf as a note in Books; set its status and finish date on its card. It asks to fetch from
openlibrary.org, to read and create notes in Books, to change their properties, and to load cover images.
