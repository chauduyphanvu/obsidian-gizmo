---
app: Keep track of what I must renew or send in by a date, and get told when one is two weeks away
data:
  deadlines:
    source: deadlines
    compute:
      days: days(today(), due)
    fields:
      what: text
      due: date
      done: checkbox
panels:
  - view: form
    title: Add a deadline
    fields:
      what: text
      due: date
    save: deadlines
    label: Add
  - view: number
    title: Next deadline
    source: deadlines
    where: {done: "!= true", due: upcoming}
    sort: due
    field: due
    agg: first
    format: until
    label: to go
  - view: table
    title: Coming up
    source: deadlines
    where: {done: "!= true"}
    sort: due
    columns: [what, due, days, done]
    labels: {what: What, due: Due, days: Days left, done: Done}
    edit: [due, done]
    alert: {days: "<= 14"}
  - view: list
    title: Done
    source: deadlines
    where: {done: true}
    sort: -due
    item: "{what}, due {due}"
---
Add each renewal or deadline (a passport, an insurance policy, a benefits enrollment) with the day
it is due. Coming up lists them soonest first with the days left, and you get a notice when one is
two weeks away or overdue; tick Done when it is handled, or change the date if it moves. It asks for
nothing; everything is saved in Renewals data.
