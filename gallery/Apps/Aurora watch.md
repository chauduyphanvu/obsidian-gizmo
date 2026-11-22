---
app: Get told when an aurora is likely and keep my own record of what I saw
refresh: 10m
data:
  kp:
    source: https://services.swpc.noaa.gov/json/planetary_k_index_1m.json
    sort: -time_tag
    limit: 1
    record: 1h
  forecast:
    source: https://services.swpc.noaa.gov/products/noaa-planetary-k-index-forecast.json
panels:
  - view: number
    title: Kp now
    source: kp
    field: estimated_kp
    decimals: 2
    label: 5 and up is a geomagnetic storm
    alert: ">= 5"
    pin: status
  - view: button
    label: Saw aurora
    save: sightings
    notify: Sighting saved
    shortcut: saw-aurora
  - view: line
    title: Kp, the past week and the next three days
    source: forecast
    x: time_tag
    y: kp
    goal: 5
  - view: list
    title: Expected to reach Kp 5
    source: forecast
    where: {observed: predicted, kp: ">= 5"}
    item: "{time_tag} · Kp {kp}"
    decimals: 2
    alert: {kp: ">= 5"}
  - view: line
    title: My Kp record
    source: kp_log
    where: {at: last 30 days}
    x: at
    y: estimated_kp
    goal: 5
  - view: table
    title: My sightings
    source: sightings
    sort: -at
    columns: [at, note]
    format: {at: datetime}
    edit: [note]
---
You get a notice when Kp reaches 5 or the forecast says it will, and the value sits in the status
bar; press Saw aurora when you see one (a hotkey or its copied link
works with the app closed), then add a note to it in the table. It asks to fetch from
services.swpc.noaa.gov, and keeps an hourly Kp record while Obsidian is open.
