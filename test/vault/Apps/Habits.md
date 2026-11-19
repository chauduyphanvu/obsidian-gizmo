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
    tab: Weeks
    title: Stretches per week
    source: stretches
    group: at
    per: week
    where: {at: last 8 weeks}
  - view: pie
    tab: Moods
    title: Moods
    source: stretches
    group: mood
  - view: list
    tab: Moods
    span: 2
    title: How it felt
    source: stretches
    group: mood
    sort: -count
  - view: calendar
    tab: Year
    title: My year of stretching
    source: stretches
    group: at
    layout: year
---
