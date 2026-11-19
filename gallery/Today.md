# Today

A plain note, not an app: the blocks below are small apps that live in its text. Press a button
and the count beside it follows.

## Meds

```gizmo
app: "[[Medication log]]"
panels: [Took meds, Doses today]
```

## Water

```gizmo
panels:
  - view: button
    label: Drank a glass of water
    save: water
  - view: progress
    title: Glasses today
    source: water
    where: {at: today}
    max: 8
    unit: glasses
```

## Notes

Write the rest of the day here, as in any note.
