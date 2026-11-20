---
app: Log the chores we do on our own phones and see who did what this week
devices: split
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
computer saves the chores done on it into a note of its own in Household chores data (named for the
device, as Settings → Gizmo calls it), so two people logging at the same moment never overwrite
each other's rows; the app reads every device's note together. Fixing a row in Lately writes the
note of the device that saved it. It asks only to keep those notes, one per device.
