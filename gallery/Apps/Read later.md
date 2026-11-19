---
app: Save articles from a few feeds to read later and tick them off
data:
  saved:
    source: notes
    from: Reading
    fields:
      read: checkbox
panels:
  - view: number
    tab: To read
    title: Still to read
    source: saved
    where: {read: "!= true"}
    label: saved articles
  - view: table
    tab: To read
    title: Reading list
    source: saved
    where: {read: "!= true"}
    sort: -at
    columns: [name, via, link, read]
    cells: {link: link, read: check}
    edit: [read]
  - view: list
    tab: Read
    title: Read
    source: saved
    where: {read: true}
    sort: -at
    limit: 10
    item: "{name} · {via}"
  - view: list
    tab: BBC technology
    title: Latest
    source: https://feeds.bbci.co.uk/news/technology/rss.xml
    limit: 10
    item: "{title}"
    action: Save
    save: Reading/
    name: "{title}"
    row:
      link: "{link}"
      date: "{date}"
      via: BBC technology
    notify: Saved {title} to Reading
  - view: list
    tab: NPR news
    title: Latest
    source: https://feeds.npr.org/1001/rss.xml
    limit: 10
    item: "{title}"
    action: Save
    save: Reading/
    name: "{title}"
    row:
      link: "{link}"
      date: "{date}"
      via: NPR news
    notify: Saved {title} to Reading
---
Save puts an article from a feed tab in the Reading folder as a note holding its link; open the
link from the reading list and tick read when you have got to it. It asks to fetch from
feeds.bbci.co.uk and feeds.npr.org, and to read, create and change the properties of notes in
Reading.
