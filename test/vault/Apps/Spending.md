---
app: Log what I spend and see where it goes
data:
  spend:
    source: spend
    fields:
      amount: number
      category: [food, rent, transport, fun, other]
      note: text
panels:
  - view: form
    title: Spent something
    save: spend
    label: Add
  - view: number
    title: This week
    source: spend
    field: amount
    agg: sum
    where: {at: this week}
    format: "$0,0.00"
    compare: previous
    label: spent so far
  - view: bar
    title: Each week against the budget
    source: spend
    compute:
      food: "if(category == 'food', amount, 0)"
      rent: "if(category == 'rent', amount, 0)"
      transport: "if(category == 'transport', amount, 0)"
      fun: "if(category == 'fun', amount, 0)"
      other: "if(category == 'other', amount, 0)"
    group: at
    per: week
    y: [food, rent, transport, fun, other]
    agg: sum
    where: {at: last 8 weeks}
    stack: true
    goal: 400
    format: "$0,0"
    labels: {food: Food, rent: Rent, transport: Transport, fun: Fun, other: Other}
  - view: table
    title: Recent
    source: spend
    sort: -at
    limit: 10
    columns: [at, amount, category, note]
    labels: {at: When, amount: Spent}
    format: {amount: "$0,0.00", at: relative}
    edit: [category]
---
Add each purchase as you make it. The number compares this week with last; the bars stack each
week's spending by category against the budget line (change `goal` to your own). Fix a category
in the table if you picked the wrong one.
