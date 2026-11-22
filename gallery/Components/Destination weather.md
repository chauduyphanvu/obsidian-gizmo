---
component: A destination's weather now, the week ahead and a typical year
params:
  name:
  lat:
  lon:
data:
  forecast:
    source: https://api.open-meteo.com/v1/forecast?latitude=$lat&longitude=$lon&current=temperature_2m&daily=weather_code,temperature_2m_max,temperature_2m_min,precipitation_probability_max&forecast_days=7&timezone=auto
  year:
    source: https://archive-api.open-meteo.com/v1/archive?latitude=$lat&longitude=$lon&start_date=2025-01-01&end_date=2025-12-31&daily=temperature_2m_max,temperature_2m_min&timezone=auto
    pick: daily
panels:
  - view: number
    title: $name now
    source: forecast
    pick: current
    field: temperature_2m
    unit: °C
    decimals: 0
  - view: table
    title: The week ahead
    source: forecast
    pick: daily
    compute:
      range: round(temperature_2m_min) + " to " + round(temperature_2m_max) + " °C"
    columns: [time, weather_code, range, precipitation_probability_max]
    labels: {time: Day, weather_code: Sky, range: Temperature, precipitation_probability_max: Rain chance}
    values:
      weather_code:
        0: clear sky
        1: mostly clear
        2: partly cloudy
        3: overcast
        45: fog
        48: freezing fog
        51: light drizzle
        53: drizzle
        55: heavy drizzle
        56: freezing drizzle
        57: heavy freezing drizzle
        61: light rain
        63: rain
        65: heavy rain
        66: freezing rain
        67: heavy freezing rain
        71: light snow
        73: snow
        75: heavy snow
        77: snow grains
        80: showers
        81: heavy showers
        82: violent showers
        85: snow showers
        86: heavy snow showers
        95: thunderstorm
        96: thunderstorm with hail
        99: thunderstorm with heavy hail
    format: {time: date, precipitation_probability_max: "0 %"}
  - view: bar
    title: Average high and low by month, 2025
    source: year
    group: time
    per: month
    y: [temperature_2m_max, temperature_2m_min]
    agg: avg
    unit: °C
    decimals: 0
    labels: {temperature_2m_max: High, temperature_2m_min: Low}
---
Used by Trip planner, once for its destination: the weather there now, the next seven days with the
sky in words, and what a typical month looks like. It asks to fetch from Open-Meteo.
