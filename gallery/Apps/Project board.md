---
app: Move my projects from idea to done and open the one I'm working on
data:
  projects:
    source: notes
    from: Projects
    fields:
      name: text
      status: {type: [idea, doing, done], default: idea}
      area: text
      start: date
      due: date
panels:
  - view: form
    title: New project
    fields: [name, area, start, due]
    save: projects
    label: Add
  - view: board
    title: Projects
    source: projects
    group: status
    item: "{name} · {area}"
    detail: "{name} is {status}, due {due} ({area})"
  - view: timeline
    title: Schedule
    source: projects
    start: start
    end: due
---
Add a project, then drag its card to another column (or use its Move to… menu) as it moves along;
click a card to see its dates and Open its note from there. It asks to read, create and
change the properties of notes in Projects, where each project is one note.
