# Today

My day at a glance, with the things I log.

```gizmo
app: "[[Meds]]"
panels: [Took meds]
```

```gizmo
panels:
  - view: button
    label: Drank a glass of water
    save: water
  - view: number
    title: Glasses today
    source: water
    where: {at: today}
    agg: count
    unit: of 8
```
