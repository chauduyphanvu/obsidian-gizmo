---
app: Did I stretch today?
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
  - view: bar
    title: Stretches per week
    source: stretches
    group: at
    per: week
    where: {at: last 8 weeks}
  - view: list
    title: How it felt
    source: stretches
    group: mood
    sort: -count
---
