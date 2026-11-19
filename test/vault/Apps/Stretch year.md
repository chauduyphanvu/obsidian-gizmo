---
app: Log a stretch and see my year
panels:
  - view: button
    label: Stretched
    save: stretches
  - view: number
    title: Streak
    source: stretches
    group: at
    per: day
    agg: streak
    unit: days
  - view: calendar
    title: My year of stretching
    source: stretches
    group: at
    layout: year
---
Press the button each time you stretch. The streak counts days in a row; each day of the year
turns bluer the more times you stretched.
