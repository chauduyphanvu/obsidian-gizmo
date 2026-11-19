---
app: SPY price, last 6 months
panels:
  - view: number
    title: SPY
    source: https://query1.finance.yahoo.com/v8/finance/chart/SPY?range=6mo&interval=1d
    pick: chart.result.0.meta
    field: regularMarketPrice
    unit: USD
    decimals: 2
  - view: line
    source: https://query1.finance.yahoo.com/v8/finance/chart/SPY?range=6mo&interval=1d
    pick: chart.result.0
    x: timestamp
    y: indicators.quote.0.close
    decimals: 0
---
