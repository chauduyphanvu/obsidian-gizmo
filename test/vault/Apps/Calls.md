---
app: Log a call; a call to return becomes an errand, and one that goes overdue becomes another
data:
  calls:
    source: calls
    fields:
      who: {label: Who}
      back: {type: date, label: Call back by}
panels:
  - view: form
    title: Log a call
    fields: [who, back]
    save: calls
    label: Log
    shortcut: log
    then: {app: "[[Errands]]", do: add, fill: {errand: "Call {who} back by {back}"}}
  - view: number
    title: Overdue call-backs
    source: calls
    agg: count
    label: calls to return
    alert: {back: past}
    then: {app: "[[Errands]]", do: add, fill: {errand: "Overdue: call {who}"}}
  - view: table
    title: Calls
    source: calls
    sort: -at
    columns: [who, back]
---
Log each call you need to return with the day you'll call back by: it becomes an errand in Errands,
and if the day passes without a call it adds another. It asks to run Errands' add.
