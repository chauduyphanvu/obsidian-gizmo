---
app: Log my weight and chart it
panels:
  - view: form
    fields: {weight: number, note: text}
    save: weights
    label: Log
  - view: number
    title: Latest
    source: weights
    field: weight
    unit: kg
  - view: number
    title: 30-day average
    source: weights
    where: {at: last 30 days}
    field: weight
    agg: avg
    unit: kg
  - view: line
    source: weights
    x: at
    y: weight
    unit: kg
---
