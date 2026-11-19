---
app: Follow the stocks I own, record each buy, and see what my holdings cost and are worth
refresh: 15m
inputs:
  symbol: [SPY, QQQ, VTI, AAPL, MSFT]
  range: [6mo, 1y, 5y]
panels:
  - use: "[[Ticker]]"
    with: {symbol: $symbol, range: $range}
  - view: table
    title: Everything I hold
    source: buys
    compute:
      paid: shares * price
    where: {shares: "> 0"}
    group: symbol
    agg: sum
    columns: [symbol, shares, paid]
    labels: {symbol: Stock, shares: Shares, paid: Paid}
    format: {paid: "$0,0.00"}
  - view: number
    title: Paid in all
    source: buys
    compute:
      paid: shares * price
    where: {shares: "> 0"}
    field: paid
    agg: sum
    format: "$0,0.00"
    label: for every share I hold
---
Pick a stock (edit the list in `inputs` to follow your own) and a range to see it through the
Ticker component; record each buy there. Everything I hold adds up every stock you have bought.
It only records shares you own. It asks to fetch from query1.finance.yahoo.com and nothing else.
