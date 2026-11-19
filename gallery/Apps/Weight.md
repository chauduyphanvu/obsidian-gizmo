---
app: Log my weight and watch the trend toward my goal
panels:
  - view: form
    title: Weigh in
    fields: {weight: number, note: text}
    save: weights
    label: Log
  - view: number
    title: This week
    source: weights
    where: {at: this week}
    field: weight
    agg: avg
    compare: previous
    unit: kg
    decimals: 1
    label: average
  - view: number
    title: Latest
    source: weights
    sort: at
    field: weight
    agg: last
    unit: kg
  - view: line
    title: Weight against my goal
    source: weights
    where: {at: last 6 months}
    x: at
    y: weight
    unit: kg
    goal: 75
  - view: table
    title: Entries
    source: weights
    sort: -at
    limit: 10
    columns: [at, weight, note]
    format: {at: date}
    edit: [weight, note]
---
Log your weight when you weigh in; the week's average is compared with last week's, and the chart
draws your goal as a dashed line (change `goal` and `kg` to suit). Fix a typo by editing the entry
in the table. It asks for nothing; entries are saved in Weight data.
