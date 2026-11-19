---
app: Keep my health appointments in one place, book the next one, and tick it off or move it
refresh: 1h
inputs:
  day: date
data:
  visits:
    source: notes
    from: Health
    compute:
      what: coalesce(what, name)
    fields:
      date: date
      who: text
      done: checkbox
panels:
  - view: list
    title: Coming up
    source: visits
    where: {date: upcoming, done: "!= true"}
    sort: date
    item: "{date} · {what} with {who}"
    format: {date: relative}
    span: 3
  - view: number
    title: Next appointment
    source: visits
    where: {date: upcoming, done: "!= true"}
    sort: date
    field: date
    agg: first
    format: until
    label: until the next one; I'm told the day before
    pin: status
    alert: {date: next 1 day}
  - view: form
    title: Book an appointment
    fields:
      what: text
      date: date
      who: text
    save: Health/
    name: "{what} {date}"
    row:
      what: "{what}"
      date: "{date}"
      who: "{who}"
    notify: Booked {what} on {date}
    label: Book
  - view: list
    title: On $day
    source: visits
    where: {date: $day}
    item: "{what} with {who}"
  - view: table
    title: All appointments
    source: visits
    sort: -date
    columns: [name, date, who, done]
    labels: {name: Note, date: Date, who: With, done: Done}
    edit: [date, done]
---
Every note in Health with a `date` is an appointment. Book one with the form (it becomes a note in
Health you can add to), pick a day in the bar to see that day, and tick Done or change the date in
the table when it happens or moves. The next one sits in the status bar and you get a notice the day
before. It asks to read, create and change the properties of notes in Health.
