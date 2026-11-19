---
component: Price and chart for one stock
params:
  symbol:
  range: 6mo
data:
  chart:
    source: https://query1.finance.yahoo.com/v8/finance/chart/$symbol?range=$range&interval=1d
panels:
  - view: number
    title: $symbol
    source: chart
    pick: chart.result.0.meta
    field: regularMarketPrice
    unit: USD
    decimals: 2
  - view: line
    title: $symbol, last $range
    source: chart
    pick: chart.result.0
    x: timestamp
    y: indicators.quote.0.close
    decimals: 0
---
Used by Watchlist and AAPL.
