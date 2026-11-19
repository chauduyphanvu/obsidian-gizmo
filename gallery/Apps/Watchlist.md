---
app: Watch a stock, record what I buy and see what my holdings are worth
refresh: 15m
inputs:
  symbol: [SPY, QQQ, VTI, AAPL, MSFT]
  range: [3mo, 6mo, 1y]
data:
  chart:
    source: https://query1.finance.yahoo.com/v8/finance/chart/$symbol?range=$range&interval=1d
  days:
    source: chart
    pick: chart.result.0.indicators.quote.0
    compute:
      change: round((close - prev(close)) / prev(close) * 100, 2)
panels:
  - view: number
    title: $symbol
    source: chart
    pick: chart.result.0.meta
    field: regularMarketPrice
    unit: USD
    decimals: 2
    label: last price
  - view: number
    title: Last session
    source: days
    field: change
    unit: "%"
    decimals: 2
    label: against the close before
  - view: line
    title: $symbol, last $range
    source: chart
    pick: chart.result.0
    x: timestamp
    y: indicators.quote.0.close
    decimals: 2
  - view: form
    title: Record a buy of $symbol
    fields:
      date: date
      shares: number
      price: number
    save: buys
    row:
      symbol: $symbol
      date: "{date}"
      shares: "{shares}"
      price: "{price}"
    label: Record
  - view: table
    title: My positions
    source: buys
    compute:
      cost: shares * price
    where: {shares: "> 0"}
    group: symbol
    agg: sum
    columns: [symbol, shares, cost]
    labels: {cost: Paid}
    format: {cost: "$0,0.00"}
    select: position
  - view: number
    title: $position.symbol is worth
    source: https://query1.finance.yahoo.com/v8/finance/chart/$position.symbol?range=5d&interval=1d
    pick: chart.result.0.indicators.quote.0
    compute:
      value: close * $position.shares
    where: {close: "> 0"}
    field: value
    format: "$0,0.00"
    label: at the last close
  - view: number
    title: Gain or loss
    source: https://query1.finance.yahoo.com/v8/finance/chart/$position.symbol?range=5d&interval=1d
    pick: chart.result.0.indicators.quote.0
    compute:
      gain: close * $position.shares - $position.cost
    where: {close: "> 0"}
    field: gain
    format: "$0,0.00"
    label: against what I paid
  - view: table
    title: My buys
    source: buys
    sort: -date
    columns: [date, symbol, shares, price]
    format: {price: "$0,0.00"}
    edit: [shares, price]
---
Pick a symbol (edit the list to follow your own) to see its price, the last session's move and a chart,
and record each buy you make; pick a position to see what it is worth now. It only records shares you
own, and setting a buy's shares to 0 takes it out of your positions. It asks to fetch from
query1.finance.yahoo.com, and nothing else.
