---
component: A city's weather now, and its last twelve months
params:
  name:
  lat:
  lon:
data:
  now:
    source: https://api.open-meteo.com/v1/forecast?latitude=$lat&longitude=$lon&current=temperature_2m,apparent_temperature,relative_humidity_2m,wind_speed_10m&temperature_unit=fahrenheit&wind_speed_unit=mph&timezone=auto
    pick: current
  year:
    source: https://archive-api.open-meteo.com/v1/archive?latitude=$lat&longitude=$lon&start_date=2025-11-01&end_date=2026-10-31&daily=temperature_2m_max,temperature_2m_min,precipitation_sum&temperature_unit=fahrenheit&precipitation_unit=inch&timezone=auto
    pick: daily
panels:
  - view: number
    title: $name now
    source: now
    field: temperature_2m
    unit: °F
    decimals: 0
  - view: text
    title: Feels like
    source: now
    text: "{apparent_temperature}°F, humidity {relative_humidity_2m}%, wind {wind_speed_10m} mph"
  - view: bar
    title: Average high and low by month, Nov 2025 – Oct 2026
    source: year
    group: time
    per: month
    y: [temperature_2m_max, temperature_2m_min]
    agg: avg
    unit: °F
    decimals: 0
  - view: bar
    title: Rain by month
    source: year
    group: time
    per: month
    y: precipitation_sum
    agg: sum
    unit: in
    decimals: 1
---
Used by Planet Earth, once per city.
