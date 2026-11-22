---
app: Keep every trade, see what I hold and what it cost, plan my buys, and watch the price
invest_monthly: 6000
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
  held:
    source: https://query1.finance.yahoo.com/v8/finance/chart/$position.symbol?range=5d&interval=1d
    pick: chart.result.0.indicators.quote.0
    where: {close: "> 0"}
  sorted:
    source: "[[Trade]]"
    compute:
      key: symbol + " " + at
    sort: key
  ledger:
    source: sorted
    compute:
      first: prev(symbol) != symbol
      before: if(first, 0, prev(held))
      held: before + if(side == "sell", -shares, shares)
      basis_before: if(first, 0, prev(basis))
      avg_before: if(before > 0, basis_before / before, 0)
      basis: if(side == "sell", if(held > 0, basis_before - shares * avg_before, 0), basis_before + shares * price)
      avg_cost: if(held > 0, basis / held, "")
      realized: if(side == "sell" && shares <= before, round(shares * (price - avg_before), 2), 0)
  ledger_rows:
    source: ledger
  latest_first:
    source: ledger
    sort: -key
  holdings:
    source: latest_first
    compute:
      newest: prev(symbol) != symbol
    where: {newest: true, held: "> 0"}
  book:
    source: "[[Trade]]"
    lines: [logged, attested]
    compute:
      key: symbol + " " + at
    sort: key
  book_rows:
    source: book
  plans:
    source: "[[Trade]]"
    lines: planned
    where: {matched: ""}
    compute:
      cash: shares * price
    sort: at
  plan_rows:
    source: plans
tabs:
  Holdings:
    - view: number
      title: Cost of what I hold
      source: holdings
      field: basis
      agg: sum
      format: "$0,0.00"
      label: paid for the shares I hold, at average cost
    - view: number
      title: Bought this month
      source: "[[Trade]]"
      compute:
        cash: shares * price
      where: {side: buy, at: this month}
      field: cash
      agg: sum
      format: "$0,0.00"
      compare: previous
      alert: "> $this.invest_monthly"
    - view: number
      title: Realized this year
      source: ledger_rows
      where: {at: this year}
      field: realized
      agg: sum
      format: "$0,0.00"
      label: gain on what I sold, at average cost
    - view: form
      title: A trade
      save: "[[Trade]]"
      fields: [symbol, side, shares, price, note]
      label: Log
    - view: reconcile
      title: From my broker, not checked yet
      source: "[[Trade]]"
      empty: Nothing from your broker waits. Drop its CSV export of trades in Inbox/Broker.
    - view: table
      title: What I hold
      source: holdings
      columns: [symbol, held, avg_cost, basis]
      labels: {symbol: Symbol, held: Shares, avg_cost: Average cost, basis: Cost basis}
      format: {avg_cost: "$0,0.00", basis: "$0,0.00"}
      select: position
      empty: No shares held. Log a buy above, e.g. VTI buy 5 312.40, or drop your broker's export in Inbox/Broker.
    - view: number
      title: $position.symbol is worth
      source: held
      compute:
        value: close * $position.held
      field: value
      format: "$0,0.00"
      label: at the last close
    - view: number
      title: Against what I paid
      source: held
      compute:
        gain: close * $position.held - $position.basis
      field: gain
      format: "$0,0.00"
      label: gain or loss at the last close, not counting what I sold
    - view: table
      title: Sells over what I hold
      source: book_rows
      compute:
        first: prev(symbol) != symbol
        before: if(first, 0, prev(held))
        held: before + if(side == "sell", -shares, shares)
        over: side == "sell" && shares > before
        from: if(line == "attested", "the broker's, not checked yet", "logged")
      where: {over: true}
      sort: -at
      columns: [at, symbol, shares, before, from]
      labels: {at: When, symbol: Symbol, shares: Sold, before: Held before, from: From}
      format: {at: date}
      alert: {over: true}
      empty: No sell is over what you hold.
    - view: bar
      title: Realized gain each year, at average cost
      source: ledger_rows
      where: {side: sell}
      group: at
      per: year
      y: realized
      agg: sum
      format: "$0,0"
      labels: {realized: Realized}
      empty: No sell logged yet.
  Plan:
    - view: number
      title: Still to buy
      source: plan_rows
      where: {side: buy}
      field: cash
      agg: sum
      format: "$0,0.00"
      label: in buys planned and not filled yet
    - view: text
      title: Next tranche
      source: plan_rows
      where: {at: upcoming}
      text: "{shares} {symbol}, {at}"
      format: {at: relative}
      empty: Nothing planned
    - view: form
      title: Plan a buy
      save: "[[Trade]]"
      fields: [symbol, shares, price]
      row: {symbol: "{symbol}", side: buy, shares: "{shares}", price: "{price}"}
      label: Plan buy
      alias: tranche
    - view: table
      title: Planned buys
      source: plan_rows
      columns: [at, symbol, shares, price, cash]
      labels: {at: When, symbol: Symbol, shares: Shares, price: Price, cash: Cash}
      format: {at: date, price: "$0,0.00", cash: "$0,0.00"}
      edit: [shares, price]
      empty: No buy planned. Plan one with its day, e.g. VTI 5 310 @+14d, or each month with @every month from 2026-12-01 until 2027-06-01.
  Watch:
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
  Trades:
    - view: table
      title: Every trade
      source: "[[Trade]]"
      sort: -at
      columns: [at, symbol, side, shares, price, note]
      labels: {at: When, symbol: Symbol, side: Side, shares: Shares, price: Price, note: Note}
      format: {at: date, price: "$0,0.00"}
      edit: [shares, price, note]
      empty: No trade logged yet.
---
Made-up trades at made-up prices to start with; this is a record of what you did, not advice on
what to do. Each buy and sell is a row of the kind Trade, long only: a sell takes shares you hold,
never more. Log one on the line here or with `trade VTI buy 5 312.40` in Gizmo: Do…, or drop your
broker's CSV export of trades in Inbox/Broker, where its rows wait under From my broker until you
check them, and one you logged pairs with it rather than counting twice. What I hold works out each
symbol's shares, average cost and cost basis from every trade; pick one to see what it is worth at
the last close and against what you paid. A sell that would take a symbol below zero shows under
Sells over what I hold, the broker's ones too while they wait: usually it is shares you bought
before you started logging, so log them as a buy on the day you bought them. Realized gain is
worked out at average cost, not lot by lot, year by year.

Plan buys in tranches on Plan: `VTI 5 310 @2026-12-01`, or `@every month from 2026-12-01 until
2027-06-01`; `@dec 1` is the next December 1, and `+14d` two weeks from now. The buy that fills
a tranche settles it, whatever its price, and Gizmo: Next asks about a tranche whose day passed
with nothing filling it. Bought this month tells you when it passes `invest_monthly` at the top.
To try a buy first, run What if… from the tab menu and add it: it shows the month's buys and what
you would hold, and nothing real changes until Keep. Watch shows a symbol's price; edit the list in
`inputs` to follow your own. It asks to fetch from query1.finance.yahoo.com, and to read and change
the rows of Trade.
