---
app: London weather now and for the next 24 hours
refresh: 30m
panels:
  - view: number
    title: Now
    source: https://api.open-meteo.com/v1/forecast?latitude=51.51&longitude=-0.13&current=temperature_2m,apparent_temperature,wind_speed_10m&hourly=temperature_2m&forecast_days=1&timezone=auto
    pick: current
    field: temperature_2m
    unit: °C
    label: London
  - view: text
    title: Feels like
    source: https://api.open-meteo.com/v1/forecast?latitude=51.51&longitude=-0.13&current=temperature_2m,apparent_temperature,wind_speed_10m&hourly=temperature_2m&forecast_days=1&timezone=auto
    pick: current
    text: "{apparent_temperature}°C, wind {wind_speed_10m} km/h"
  - view: line
    title: Next 24 hours
    source: https://api.open-meteo.com/v1/forecast?latitude=51.51&longitude=-0.13&current=temperature_2m,apparent_temperature,wind_speed_10m&hourly=temperature_2m&forecast_days=1&timezone=auto
    pick: hourly
    x: time
    y: temperature_2m
    unit: °C
---
