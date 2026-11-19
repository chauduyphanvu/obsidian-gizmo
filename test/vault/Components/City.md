---
component: A city's weather now, and its last three months week by week
params:
  name:
  lat:
  lon:
data:
  weather:
    source: https://api.open-meteo.com/v1/forecast?latitude=$lat&longitude=$lon&current=temperature_2m,apparent_temperature,relative_humidity_2m,wind_speed_10m&daily=temperature_2m_max,temperature_2m_min,precipitation_sum&past_days=92&forecast_days=1&temperature_unit=fahrenheit&wind_speed_unit=mph&precipitation_unit=inch&timezone=auto
  days:
    source: weather
    pick: daily
    where: {time: last 13 weeks}
panels:
  - view: number
    title: $name now
    source: weather
    pick: current
    field: temperature_2m
    unit: °F
    decimals: 0
  - view: text
    title: Feels like
    source: weather
    pick: current
    text: "{apparent_temperature}°F, humidity {relative_humidity_2m}%, wind {wind_speed_10m} mph"
  - view: bar
    title: Average high and low by week, last three months
    source: days
    group: time
    per: week
    y: [temperature_2m_max, temperature_2m_min]
    agg: avg
    labels: {temperature_2m_max: High, temperature_2m_min: Low}
    unit: °F
    decimals: 0
  - view: bar
    title: Rain by week
    source: days
    group: time
    per: week
    y: precipitation_sum
    agg: sum
    labels: {precipitation_sum: Rain}
    unit: in
    decimals: 1
---
Used by Planet Earth, once per city: the weather there now, and the last thirteen weeks of highs,
lows and rain from one Open-Meteo request (no key), always ending today.
