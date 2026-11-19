---
app: Convert money between two currencies, watch the rate, and keep a log of what I send
refresh: 1h
inputs:
  have: [USD, EUR, GBP, JPY, CAD]
  want: [EUR, USD, GBP, JPY, CAD]
  amount: text
data:
  today:
    source: https://api.frankfurter.dev/v2/rates?base=$have&quotes=$want
panels:
  - view: number
    title: 1 $have in $want
    source: today
    field: rate
    decimals: 4
    label: today's reference rate
    alert: ">= 0.95"
  - view: list
    title: Converted
    source: today
    compute:
      sent: number($amount)
      gets: round(number($amount) * rate, 2)
    item: "{sent} {base} is {gets} {quote} at {rate}"
    format: {sent: "0,0.00", gets: "0,0.00", rate: "0.0000"}
    span: 3
    action: I sent it
    save: transfers
    row:
      date: "{date}"
      sent: "{sent}"
      from: "{base}"
      got: "{gets}"
      to: "{quote}"
      rate: "{rate}"
    notify: Logged {sent} {base} → {gets} {quote}
  - view: line
    title: $have in $want, week by week since 2025
    source: https://api.frankfurter.dev/v2/rates?base=$have&quotes=$want&from=2025-01-01&group=week
    x: date
    y: rate
    labels: {rate: Rate}
    format: "0.0000"
  - view: table
    title: What I sent
    source: transfers
    sort: -at
    columns: [date, sent, from, got, to, rate, note]
    labels: {date: Date, sent: Sent, from: From, got: Got, to: To, rate: Rate, note: Note}
    format: {sent: "0,0.00", got: "0,0.00", rate: "0.0000"}
    edit: [note]
---
Pick the currency you have and the one you want (edit the lists to your own), type an amount, and
it is converted at today's reference rate from Frankfurter (no key). Press I sent it after a
transfer to log what you sent and the rate you got, then add who it was for in the table. You get
a notice when 1 of the first currency in `have` buys 0.95 of the first in `want` or more (change
`alert` to the rate you are waiting for). It asks to fetch from api.frankfurter.dev and nothing else.
