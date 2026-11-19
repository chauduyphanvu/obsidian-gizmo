# Today

My day at a glance, with the things I log.

```note-app
app: "[[Meds]]"
panels: [Took meds]
```

```note-app
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
