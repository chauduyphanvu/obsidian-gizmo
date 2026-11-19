---
app: London weather now and for the next 24 hours
refresh: 30m
data:
  forecast:
    source: https://api.open-meteo.com/v1/forecast?latitude=51.51&longitude=-0.13&current=temperature_2m,apparent_temperature,wind_speed_10m&hourly=temperature_2m,apparent_temperature&forecast_days=1&timezone=auto
panels:
  - view: number
    title: Now
    source: forecast
    pick: current
    field: temperature_2m
    unit: °C
    label: London
  - view: text
    title: Feels like
    source: forecast
    pick: current
    text: "{apparent_temperature}°C, wind {wind_speed_10m} km/h"
  - view: line
    title: Next 24 hours
    source: forecast
    pick: hourly
    x: time
    y: [temperature_2m, apparent_temperature]
    unit: °C
---
