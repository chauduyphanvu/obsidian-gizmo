---
app: Pick a stock and a range
inputs:
  symbol: [SPY, QQQ, AAPL]
  range: [6mo, 1y, 5y]
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
  - view: form
    title: Note to self
    fields: {note: text}
    save: ideas
    label: Keep
  - view: line
    title: $symbol, last $range
    source: chart
    pick: chart.result.0
    x: timestamp
    y: indicators.quote.0.close
    decimals: 0
---
