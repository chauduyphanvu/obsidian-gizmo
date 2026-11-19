---
app: "Plan my projects: move them along a board and see when they're due"
data:
  projects:
    source: notes
    from: Projects
    fields:
      status: [idea, doing, done]
panels:
  - view: board
    title: Projects
    source: projects
    group: status
    item: "{name} · {area}"
  - view: timeline
    title: Schedule
    source: projects
    start: start
    end: due
    detail: "{name} is due {due}"
  - view: calendar
    title: Due dates
    source: projects
    group: due
    span: 3
---
Drag a project to another column (or use its Move to… menu) to change its status; the note's
`status` property is what changes. Pick a bar on the schedule to see when that project is due, and open its note from there.
