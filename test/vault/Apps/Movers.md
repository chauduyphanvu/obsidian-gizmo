---
app: Watch a stock's big moves and note why they happened
inputs:
  symbol: [SPY, QQQ, AAPL]
data:
  quote:
    source: https://query1.finance.yahoo.com/v8/finance/chart/$symbol?range=3mo&interval=1d
    pick: chart.result.0.indicators.quote.0
  days:
    source: quote
    compute:
      session: "coalesce(prev(session), 0) + 1"
      change: "round((close - prev(close)) / prev(close) * 100, 2)"
      move: "abs(change)"
  big:
    source: days
    where: {move: "> 1"}
panels:
  - view: number
    title: $symbol, last session
    source: days
    field: change
    unit: "%"
    decimals: 2
  - view: number
    title: Best session
    source: days
    field: change
    agg: max
    unit: "%"
    decimals: 2
    label: last 3 months
  - view: number
    title: Worst session
    source: days
    field: change
    agg: min
    unit: "%"
    decimals: 2
    label: last 3 months
  - view: number
    title: Moves over 1%
    source: big
    label: sessions, up or down
  - view: bar
    title: Change per trading session, last 3 months
    source: days
    x: session
    y: change
    unit: "%"
    decimals: 2
  - view: table
    title: Biggest moves
    source: big
    compute:
      when: '"session " + session'
    sort: -move
    limit: 5
    columns: [when, close, change]
    decimals: 2
    select: day
  - view: form
    title: Why did it move?
    fields: {reason: text}
    save: reasons
    row:
      symbol: $symbol
      session: $day.session
      close: $day.close
      change: $day.change
      reason: "{reason}"
    label: Note it
  - view: list
    title: Why they moved
    source: reasons
    sort: -at
    item: "{symbol} session {session}, {change}%: {reason}"
    format: {change: "0.00"}
---
Prices from Yahoo Finance, no API key. Each session's change is worked out from the close before it with `prev`;
pick one of the biggest moves and write down why it happened, and your notes stay in the list below.
