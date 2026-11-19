---
component: Follow one stock, record what I buy of it, and see what my shares are worth
params:
  symbol:
  range: 6mo
data:
  chart:
    source: https://query1.finance.yahoo.com/v8/finance/chart/$symbol?range=$range&interval=1d
  closes:
    source: chart
    pick: chart.result.0.indicators.quote.0
    where: {close: "> 0"}
  mine:
    source: buys
    where: {symbol: $symbol}
panels:
  - view: number
    title: $symbol
    source: chart
    pick: chart.result.0.meta
    field: regularMarketPrice
    format: "$0,0.00"
    label: last price
    pin: status
  - view: number
    title: Last session
    source: closes
    compute:
      change: round((close - prev(close)) / prev(close) * 100, 2)
    field: change
    unit: "%"
    decimals: 2
    label: against the close before; a fall of 3% or more tells me
    alert: "<= -3"
  - view: line
    title: $symbol, last $range
    source: chart
    pick: chart.result.0
    x: timestamp
    y: indicators.quote.0.close
    labels: {indicators.quote.0.close: Close}
    format: "$0,0.00"
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
    title: What I hold
    source: buys
    compute:
      paid: shares * price
    where: {symbol: $symbol, shares: "> 0"}
    group: symbol
    agg: sum
    columns: [symbol, shares, paid]
    labels: {symbol: Stock, shares: Shares, paid: Paid}
    format: {paid: "$0,0.00"}
    select: holding
  - view: number
    title: Worth now
    source: https://query1.finance.yahoo.com/v8/finance/chart/$holding.symbol?range=5d&interval=1d
    pick: chart.result.0.indicators.quote.0
    compute:
      value: close * $holding.shares
    where: {close: "> 0"}
    field: value
    format: "$0,0.00"
    label: $holding.shares shares of $holding.symbol at the last close
  - view: number
    title: Gain or loss
    source: https://query1.finance.yahoo.com/v8/finance/chart/$holding.symbol?range=5d&interval=1d
    pick: chart.result.0.indicators.quote.0
    compute:
      gain: close * $holding.shares - $holding.paid
    where: {close: "> 0"}
    field: gain
    format: "$0,0.00"
    label: against what I paid
  - view: table
    title: My buys of $symbol
    source: mine
    sort: -date
    columns: [date, shares, price]
    labels: {date: Bought on, shares: Shares, price: Price}
    format: {price: "$0,0.00"}
    edit: [date, shares, price]
---
One stock, from Yahoo Finance with no key: its price (kept in the status bar), the last session's
move (you get a notice when it falls 3% or more), a chart, and a form to record each buy. Pick the
row under What I hold to see what those shares are worth now; fix a buy in the table, or set its
shares to 0 to take it out. Used by Portfolio (with the symbol you pick) and by AAPL (one stock).
