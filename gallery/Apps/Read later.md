---
app: Save articles from a few feeds to read later and tick them off
data:
  articles:
    source: notes
    from: Reading
    fields:
      read: checkbox
  unread:
    source: articles
    where: {read: "!= true"}
    sort: -at
tabs:
  To read:
    - view: number
      title: Still to read
      source: unread
      label: saved articles
    - view: table
      title: Reading list
      source: unread
      columns: [name, via, link, read]
      cells: {link: link, read: check}
      edit: true
  Read:
    - view: list
      title: Read
      source: articles
      where: {read: true}
      sort: -at
      limit: 10
      item: "{name} · {via}"
  BBC technology:
    - view: list
      title: Latest
      source: https://feeds.bbci.co.uk/news/technology/rss.xml
      limit: 10
      item: "{title}"
      action: Save
      save: articles
      name: "{title}"
      row:
        link: "{link}"
        date: "{date}"
        via: BBC technology
      notify: Saved {title} to Reading
  NPR news:
    - view: list
      title: Latest
      source: https://feeds.npr.org/1001/rss.xml
      limit: 10
      item: "{title}"
      action: Save
      save: articles
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
