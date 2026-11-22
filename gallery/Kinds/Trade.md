---
kind: trade
shortcut: trade
fields:
  symbol: text
  side: [buy, sell]
  shares: number
  price: {type: number, label: Price, format: "$0,0.00"}
  note: text
import:
  broker: {folder: Inbox/Broker, at: Trade Date, side: Action, symbol: Symbol, shares: Quantity, price: Price, where: {Quantity: "> 0"}}
match:
  - {symbol: exact, side: exact, shares: exact, price: 0.01, at: 1d}
  - {symbol: exact, side: exact, shares: exact, at: 7d}
---
Each buy and sell of shares I make, at the price per share it filled at: long only, so a sell only
takes shares I hold, never more. Type `trade VTI buy 5 312.40` in Gizmo: Do… to log one. A buy
planned for a day still to come is a tranche of a plan, `trade VTI buy 5 310 @2026-12-01` (`dec 1`
is the next December 1; a weekday is the last one, as on any line), and the buy that fills it
settles it: the same symbol and shares within a week, whatever the price.

Drop your broker's CSV export of trades into Inbox/Broker (or run Gizmo: Import rows into a kind…):
each buy and sell comes in as the broker's, and dividends, interest and fees, which have no
quantity, stay out. This note shows a card that pairs each with a trade you logged, the same
symbol, side and shares on the same day at the same price; accept what is yours and Not mine what
isn't. It asks to read the files in Inbox/Broker; the rows are kept in Trade data.
