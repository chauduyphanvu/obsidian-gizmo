---
app: Planet Earth, right now
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
    label: magnitude
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
    title: Earthquakes per day
    source: quakes
    group: properties.time
    per: day
  - view: list
    tab: Earthquakes
    span: 2
    title: The ten strongest
    source: quakes
    sort: -properties.mag
    limit: 10
    item: "M{properties.mag} · {properties.place}"
  - view: list
    tab: Earthquakes
    span: 2
    title: Felt by the most people
    source: quakes
    where: {properties.felt: "> 0"}
    sort: -properties.felt
    limit: 10
    item: "{properties.felt} reports · M{properties.mag} · {properties.place}"

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
  - view: countdown
    tab: Saigon
    title: Tết
    to: 2027-02-06
    label: Lunar New Year, Year of the Goat
---
Earthquakes from USGS, the solar wind and Kp index from NOAA's Space Weather Prediction Center, weather from Open-Meteo. No API keys.
