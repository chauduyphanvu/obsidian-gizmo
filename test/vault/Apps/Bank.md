---
app: See where my money went from a bank export, and flag what to look into
data:
  spending:
    source: Finance/bank.csv
    compute:
      spent: "-Amount"
    where: {spent: "> 0"}
panels:
  - view: bar
    title: Spending per month
    source: spending
    group: Date
    per: month
    y: spent
    agg: sum
    unit: $
  - view: table
    title: Largest transactions
    source: spending
    sort: -spent
    limit: 8
    columns: [Date, Description, Amount, Category]
    select: tx
  - view: form
    title: Flag the selected transaction
    save: flagged
    label: Flag it
    fields:
      reason: text
    row:
      description: "$tx.Description"
      amount: "$tx.Amount"
      date: "$tx.Date"
      reason: "{reason}"
  - view: list
    title: To look into
    source: flagged
    sort: -at
    item: "{date} · {description} · {amount} — {reason}"
    format: {amount: "0.00"}
---
Drop a bank export (Date, Description, Amount, Category) into Finance/bank.csv. The bars show what
left the account each month; pick a row in the table of largest transactions and flag it with a
reason to keep a list of what to look into.
