---
app: Keep an eye on the planet, follow the earthquakes that matter to me, and see the weather where my family lives
spec: 1
refresh: 10m
inputs:
  period: [week, day, month]
data:
  quakes:
    source: https://earthquake.usgs.gov/earthquakes/feed/v1.0/summary/2.5_$period.geojson
    pick: features
  wind:
    source: https://services.swpc.noaa.gov/json/rtsw/rtsw_wind_1m.json
    where: {active: true}
    sort: time_tag
  kp:
    source: https://services.swpc.noaa.gov/json/planetary_k_index_1m.json
  strong:
    source: quakes
    compute:
      mag: properties.mag
      place: properties.place
      when: properties.time
      depth: geometry.coordinates.2
      felt: coalesce(properties.felt, 0)
      page: properties.url
panels:
  - view: number
    title: Earthquakes, past $period
    source: quakes
    label: magnitude 2.5 and up
  - view: number
    title: Strongest
    source: quakes
    field: properties.mag
    agg: max
    decimals: 1
    label: magnitude; I'm told when one reaches 7
    alert: ">= 7"
  - view: number
    title: Solar wind
    source: wind
    field: proton_speed
    unit: km/s
    decimals: 0
    label: reaching Earth now
  - view: progress
    title: Geomagnetic storm level
    source: kp
    field: estimated_kp
    max: 9
    decimals: 1
    label: Kp index; 5 and up is a storm

  - view: bar
    tab: Earthquakes
    span: 2
    title: Earthquakes per day
    source: quakes
    group: properties.time
    per: day
  - view: list
    tab: Earthquakes
    span: 2
    title: Felt by the most people
    source: strong
    where: {felt: "> 0"}
    sort: -felt
    limit: 10
    item: "{felt} reports · M{mag} · {place}"
    format: {mag: "0.0"}
  - view: table
    tab: Earthquakes
    span: 2
    title: The ten strongest
    source: strong
    sort: -mag
    limit: 10
    columns: [mag, place, when]
    labels: {mag: Magnitude, place: Where, when: When}
    format: {mag: "0.0", when: relative}
    select: quake
    action: Follow
    save: following
    row:
      quake: "{properties.title}"
      when: "{when}"
      page: "{page}"
    notify: Following {place}
  - view: table
    tab: Earthquakes
    span: 2
    title: The one I picked
    source: strong
    where: {id: $quake.id}
    columns: [place, mag, when, depth, felt, page]
    labels: {place: Where, mag: Magnitude, when: When, depth: Depth, felt: Felt reports, page: USGS page}
    format: {mag: "0.0", when: datetime, depth: "0 km"}
    cells: {page: link}
    layout: cards
  - view: table
    tab: Earthquakes
    title: Quakes I'm following
    source: following
    sort: -when
    columns: [quake, when, page, note]
    labels: {quake: Quake, when: When, page: USGS page, note: Why I'm following it}
    format: {when: date}
    cells: {page: link}
    edit: [note]

  - view: line
    tab: Sun
    title: Solar wind speed (UTC)
    source: wind
    x: time_tag
    y: proton_speed
    unit: km/s
  - view: line
    tab: Sun
    title: Solar wind density (UTC)
    source: wind
    x: time_tag
    y: proton_density
    unit: per cm³
  - view: line
    tab: Sun
    title: Kp index, last 6 hours (UTC)
    source: kp
    x: time_tag
    y: estimated_kp

  - use: "[[City]]"
    with: {name: Philadelphia, lat: 39.95, lon: -75.17}
    tab: Philadelphia
  - use: "[[City]]"
    with: {name: Saigon, lat: 10.82, lon: 106.63}
    tab: Saigon
---
Earthquakes from USGS, the solar wind and Kp index from NOAA's Space Weather Prediction Center, weather
from Open-Meteo; no keys. Pick a quake among the strongest to see where and how deep it was and open its
USGS page; Follow keeps it in your list, where you can note why. You get a notice when a quake of
magnitude 7 or more is in the past week. Change the cities under the last two tabs to your own.
