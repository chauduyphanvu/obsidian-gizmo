---
app: Log the chores we do on our own phones and see who did what this week
panels:
  - view: form
    title: Did a chore
    fields:
      chore: [dishes, laundry, bins, vacuuming, bathroom, shopping, cooking, other]
      who: text
    save: done
    label: Done
    shortcut: did
  - view: number
    title: This week
    source: done
    where: {at: this week}
    agg: count
    compare: previous
    label: chores done
  - view: bar
    title: Who did what this week
    source: done
    where: {at: this week}
    group: who
    agg: count
  - view: table
    title: Lately
    source: done
    sort: -at
    limit: 15
    columns: [at, chore, who]
    labels: {at: When}
    format: {at: relative}
    edit: [chore, who]
---
For a household that shares this vault through iCloud, Syncthing or any other sync: each phone or
computer keeps what it saves in a log of its own, so two people logging at the same moment never
overwrite each other's rows, and every device reads them all together. When two people fix the same
row in Lately at once, both values are kept and the cell offers the other. It asks for nothing.
