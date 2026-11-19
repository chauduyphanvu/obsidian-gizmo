---
app: Tell me when an aurora is likely, and keep my own record of the Kp index
data:
  kp:
    source: https://services.swpc.noaa.gov/json/planetary_k_index_1m.json
    sort: -time_tag
    limit: 1
    record: 1h
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
    title: My Kp record
    source: kp_log
    x: at
    y: estimated_kp
  - view: list
    title: Sightings
    source: sightings
    sort: -at
    item: "{at}"
---
