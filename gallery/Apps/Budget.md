---
app: Log what I spend and get told when the month runs past my limit
data:
  spend:
    source: spend
    fields:
      amount: {type: number, label: Spent, format: "$0,0.00"}
      category: [food, home, transport, fun, other]
      note: text
  month:
    source: spend
    where: {at: this month}
panels:
  - view: form
    title: Spent something
    save: spend
    label: Add
  - view: number
    title: This month
    source: month
    field: amount
    agg: sum
    compare: previous
    label: spent so far
  - view: progress
    title: Against my limit
    source: month
    field: amount
    agg: sum
    max: 2000
    format: "$0,0"
    alert: ">= 2000"
  - view: bar
    title: Each week against my budget
    source: spend
    compute:
      food: if(category == 'food', amount, 0)
      home: if(category == 'home', amount, 0)
      transport: if(category == 'transport', amount, 0)
      fun: if(category == 'fun', amount, 0)
      other: if(category == 'other', amount, 0)
    where: {at: last 8 weeks}
    group: at
    per: week
    y: [food, home, transport, fun, other]
    agg: sum
    stack: true
    goal: 500
    format: "$0,0"
    labels: {food: Food, home: Home, transport: Transport, fun: Fun, other: Other}
  - view: table
    title: Recent
    source: spend
    sort: -at
    limit: 10
    columns: [at, amount, category, note]
    labels: {at: When}
    format: {at: relative}
    edit: true
---
Add each purchase as you make it. You get a notice once the month's total reaches the limit (the
2000 in `max` and `alert`), and the bars stack each week by category against the `goal` line;
change those numbers to your own budget, and fix a wrong amount or category in the table. It asks
for nothing; entries are saved in Budget data.
