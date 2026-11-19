---
app: My watchlist
inputs:
  range: [6mo, 1y]
panels:
  - use: "[[Ticker]]"
    with: {symbol: SPY, range: $range}
    tab: Index
  - use: "[[Ticker]]"
    with: {symbol: AAPL, range: $range}
    tab: Apple
---
