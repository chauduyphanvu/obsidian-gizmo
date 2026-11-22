---
app: "Plan one trip: days to go, packing, the itinerary, the weather, and what the trip will cost against its budget"
city: Tokyo
lat: 35.68
lon: 139.69
departs: 2027-03-14
returns: 2027-03-20
rate: 150
budget: 3200
data:
  spend:
    source: "[[Spend]]"
    where: {trip: $this.city}
  costs:
    source: "[[Spend]]"
    lines: [logged, planned]
    compute:
      during: days($this.departs, at) >= 0 && days(at, $this.returns) >= 0
      mine: trip == $this.city || (during && category == "travel")
      planned: line == "planned"
      spent: if(planned, 0, amount)
      to_come: if(planned, amount, 0)
      status: if(planned, "planned", "spent")
    where: {mine: true}
  cost_rows:
    source: costs
  away:
    source: "[[Spend]]"
    compute:
      during: days($this.departs, at) >= 0 && days(at, $this.returns) >= 0
      untagged: coalesce(trip, "") == "" && coalesce(category, "") == ""
    where: {during: true, untagged: true}
tabs:
  Plan:
    - view: number
      title: Days to go
      source: this
      field: departs
      format: until
      label: until I leave
    - view: number
      title: The trip comes to
      source: costs
      field: amount
      agg: sum
      format: "$0,0.00"
      label: spent, and planned still to come
      alert: "> $this.budget"
    - view: progress
      title: Against the trip's budget
      source: costs
      field: amount
      agg: sum
      max: $this.budget
      format: "$0,0"
    - view: form
      title: Plan a cost
      save: spend
      fields:
        amount: {type: number, label: Dollars, format: "$0,0.00"}
        item: text
      row:
        amount: "{amount}"
        note: "{item}"
        category: travel
        trip: $this.city
      label: Plan cost
      alias: tripcost
    - view: checklist
      title: Packing
      items: [Passport, Chargers, Plug adapter, Medication, Rain jacket, Cash]
      save: packed
      alias: pack
    - view: table
      title: The trip's money
      source: cost_rows
      sort: at
      columns: [at, note, amount, status]
      labels: {at: When, note: Item, amount: Dollars, status: ""}
      format: {at: date, amount: "$0,0.00"}
      edit: [amount]
      empty: Nothing planned for the trip yet. Plan a cost with its day, e.g. 780 Hotel in Shinjuku @2027-03-14.
  Itinerary:
    - view: table
      title: Itinerary
      source: Trips/Tokyo.ics
      sort: start
      columns: [start, summary, location]
      labels: {start: When, summary: What, location: Where}
  Spending:
    - view: number
      title: Spent so far
      source: costs
      field: spent
      agg: sum
      format: "$0,0.00"
      label: in dollars, at the rate when each was added
    - view: number
      title: Still to come
      source: costs
      field: to_come
      agg: sum
      format: "$0,0.00"
      label: in costs planned for the trip
    - view: number
      title: Today's rate
      source: https://api.frankfurter.dev/v1/latest?base=USD&symbols=JPY
      pick: rates
      field: JPY
      decimals: 2
      label: yen to the dollar; put the one you'll use in rate
    - view: form
      title: Spent abroad
      save: spend
      label: Add
      fields:
        item: text
        yen: {type: number, label: Yen, format: "¥0,0"}
      row:
        note: "{item}"
        local: "{yen}"
        amount: "=round(yen / $this.rate, 2)"
        category: travel
        trip: $this.city
    - view: table
      title: Expenses
      source: spend
      sort: -at
      columns: [note, local, amount]
      labels: {note: Item, local: Yen, amount: Dollars}
      format: {local: "¥0,0"}
      edit: [note]
      empty: Nothing spent on the trip yet. Type what you pay abroad in yen above, e.g. Ramen 1500.
    - view: table
      title: The bank's charges in the trip's days
      source: away
      sort: -at
      columns: [at, note, amount, category]
      labels: {at: When, note: Charge, amount: Dollars, category: Category}
      format: {at: date, amount: "$0,0.00"}
      edit: [category]
      empty: No charge from the bank in the trip's days yet.
  Weather:
    - use: "[[Destination weather]]"
      with: {name: $this.city, lat: $this.lat, lon: $this.lon}
---
Change city, lat, lon, departs, returns, rate and budget at the top to plan your own trip, put its
bookings in Trips/Tokyo.ics (any calendar file from a booking email), and plan each cost you know
ahead in dollars with its day: `780 Hotel in Shinjuku @2027-03-14`. Each is a planned row of the
kind Spend for this trip, so Budget counts it in its month; The trip comes to adds what is spent to
what is planned still to come, and tells you when that passes `budget`, before the money goes. To
try an excursion first, run What if… from the tab menu and add it there: it says whether the trip
would pass its budget, and nothing real changes until Keep. Abroad, log each expense in the local
currency: it is worked out in dollars at the rate in this note and kept so, and a cost you paid
settles the one you planned under the same name. A charge from your bank dated in the trip's days
has no trip or category on it; it waits under The bank's charges in the trip's days until you set
its category to travel, which brings it into the trip. It asks to fetch from api.frankfurter.dev, api.open-meteo.com and
archive-api.open-meteo.com, to read Trips/Tokyo.ics and to read and change the rows of Spend; it
needs the notes Destination weather and Spend.
