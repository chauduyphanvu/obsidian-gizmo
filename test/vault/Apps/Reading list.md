---
app: Follow a few feeds and save what I want to read later
data:
  saved:
    source: notes
    from: Reading
    fields:
      read: checkbox
panels:
  - view: list
    title: Hacker News front page
    source: https://hnrss.org/frontpage
    limit: 10
    item: "{title}"
    action: Save
    save: Reading/
    name: "{title}"
    row:
      link: "{link}"
      date: "{date}"
    notify: Saved {title} to Reading
  - view: list
    title: xkcd
    source: https://xkcd.com/atom.xml
    limit: 4
    item: "{title}"
    action: Save
    save: Reading/
    name: "{title}"
    row:
      link: "{link}"
      date: "{date}"
    notify: Saved {title} to Reading
  - view: table
    title: Reading list
    source: saved
    sort: -date
    columns: [name, date, link, read]
    edit: [read]
---
Both feeds need no key. Save puts an article in the Reading folder as a note holding its link and
date; tick read in the table when you have got to it.
