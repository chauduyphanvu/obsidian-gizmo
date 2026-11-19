---
app: Move my projects from idea to done and open the one I'm working on
data:
  projects:
    source: notes
    from: Projects
    fields:
      status: [idea, doing, done]
panels:
  - view: form
    title: New project
    fields:
      name: text
      area: text
      start: date
      due: date
    save: Projects/
    name: "{name}"
    row:
      status: idea
      area: "{area}"
      start: "{start}"
      due: "{due}"
    label: Add
  - view: board
    title: Projects
    source: projects
    group: status
    item: "{name} · {area}"
    select: project
  - view: timeline
    title: Schedule
    source: projects
    start: start
    end: due
    item: "{name}"
  - view: text
    title: The one I picked
    text: "$project.name is $project.status, due $project.due ($project.area)"
  - view: button
    label: Open $project.name
    open: $project.path
---
Add a project, then drag its card to another column (or use its Move to… menu) as it moves along;
click a card to see its dates and press the button to open its note. It asks to read, create and
change the properties of notes in Projects, where each project is one note.
