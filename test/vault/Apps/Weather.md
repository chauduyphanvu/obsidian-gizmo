---
app: Check the London weather before I go out, and log my walks with the weather they had
refresh: 30m
data:
  forecast:
    source: https://api.open-meteo.com/v1/forecast?latitude=51.51&longitude=-0.13&current=temperature_2m,apparent_temperature,weather_code,wind_speed_10m&hourly=temperature_2m,apparent_temperature,precipitation_probability&forecast_hours=24&daily=weather_code,temperature_2m_max,temperature_2m_min,precipitation_probability_max&forecast_days=7&timezone=auto
  now:
    source: forecast
    pick: current
    compute:
      sky: if(weather_code == 0, "clear", if(weather_code <= 2, "partly cloudy", if(weather_code == 3, "overcast", if(weather_code <= 48, "fog", if(weather_code <= 57, "drizzle", if(weather_code <= 67, "rain", if(weather_code <= 77, "snow", if(weather_code <= 82, "showers", if(weather_code <= 86, "snow showers", "thunderstorm")))))))))
  hours:
    source: forecast
    pick: hourly
    compute:
      wet: precipitation_probability >= 50
  week:
    source: forecast
    pick: daily
    compute:
      day: weekday(time)
      sky: if(weather_code == 0, "clear", if(weather_code <= 2, "partly cloudy", if(weather_code == 3, "overcast", if(weather_code <= 48, "fog", if(weather_code <= 57, "drizzle", if(weather_code <= 67, "rain", if(weather_code <= 77, "snow", if(weather_code <= 82, "showers", if(weather_code <= 86, "snow showers", "thunderstorm")))))))))
      range: round(temperature_2m_min) + " to " + round(temperature_2m_max) + " °C"
panels:
  - view: list
    title: Right now
    source: now
    item: "{temperature_2m}°C, feels like {apparent_temperature}°C, {sky}, wind {wind_speed_10m} km/h"
    span: 3
    action: I went for a walk
    save: walks
    row:
      sky: "{sky}"
      temp: "{temperature_2m}"
      feels: "{apparent_temperature}"
      wind: "{wind_speed_10m}"
    append: Daily.md
    line: "- Walked in London: {sky}, {temperature_2m}°C, feels like {apparent_temperature}°C, wind {wind_speed_10m} km/h"
    notify: Walk logged
  - view: number
    title: Rainy hours ahead
    source: hours
    where: {wet: true}
    agg: count
    unit: hours
    label: in the next 24, with a 50% chance or more; I'm told when there are any
    alert: ">= 1"
  - view: line
    title: Next 24 hours
    source: hours
    x: time
    y: [temperature_2m, apparent_temperature]
    labels: {temperature_2m: Temperature, apparent_temperature: Feels like}
    unit: °C
  - view: bar
    title: Chance of rain by the hour
    source: hours
    x: time
    y: precipitation_probability
    labels: {precipitation_probability: Chance of rain}
    unit: "%"
    goal: 50
  - view: table
    title: The week ahead
    source: week
    columns: [day, sky, range, precipitation_probability_max]
    labels: {day: Day, sky: Sky, range: Temperature, precipitation_probability_max: Rain chance}
    values:
      day: {1: Monday, 2: Tuesday, 3: Wednesday, 4: Thursday, 5: Friday, 6: Saturday, 7: Sunday}
    format: {precipitation_probability_max: "0 %"}
  - view: table
    title: My walks
    source: walks
    sort: -at
    limit: 10
    columns: [at, sky, temp, feels, note]
    labels: {at: When, sky: Sky, temp: °C, feels: Felt like, note: Note}
    format: {at: relative}
    edit: [note]
---
Weather from Open-Meteo, no key; change `latitude` and `longitude` in the source for your own town.
The bars show the chance of rain hour by hour against a 50% line, and you get a notice when any of
the next 24 hours is that wet. Press I went for a walk when you come back: the walk and the weather
it had are kept in the table (add a note there) and a line goes into Daily. It asks to fetch from
api.open-meteo.com and to add lines to Daily.md.
