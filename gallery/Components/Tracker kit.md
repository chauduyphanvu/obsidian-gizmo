---
component: Log a number each time I measure it, and see this week against the last and the trend toward my goal
params:
  what: weight
  unit: kg
  goal: 75
panels:
  - view: form
    title: Log my $what
    fields:
      value: {type: number, label: $what}
      note: text
    save: $what
    label: Log
  - view: number
    title: This week
    source: $what
    where: {at: this week}
    field: value
    agg: avg
    compare: previous
    unit: $unit
    decimals: 1
    label: average
  - view: number
    title: Latest
    source: $what
    sort: at
    field: value
    agg: last
    unit: $unit
  - view: line
    title: My $what against my goal
    source: $what
    where: {at: last 6 months}
    x: at
    y: value
    unit: $unit
    goal: $goal
  - view: table
    title: Entries
    source: $what
    sort: -at
    limit: 10
    columns: [at, value, note]
    labels: {value: $what}
    format: {at: date}
    edit: [value, note]
---
A whole app in one component, for anything you measure now and then and want to see move toward a
goal: your weight, how long you slept, your resting heart rate. Use it with the word for what you
measure, its unit and your goal:

    app: Log my weight and watch the trend toward my goal
    use: "[[Tracker kit]]"
    with: {what: weight, unit: kg, goal: 75}

Each entry is saved in the app's data note, in a list named after what you measure, so one app can
use the kit twice for two things. It asks for nothing. Opened on its own it tracks weight, its default.
