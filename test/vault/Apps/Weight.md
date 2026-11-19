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
weights:
  - {weight: 81.4, at: 2026-10-20T07:30}
  - {weight: 81.0, at: 2026-10-27T07:30}
  - {weight: 80.7, at: 2026-11-03T07:30}
  - {weight: 80.9, at: 2026-11-10T07:30}
  - {weight: 80.2, at: 2026-11-17T07:30}
---
