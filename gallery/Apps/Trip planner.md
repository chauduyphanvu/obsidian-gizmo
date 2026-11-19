---
app: "Plan one trip: days to go, packing, itinerary, weather and what I spend abroad"
city: Tokyo
lat: 35.68
lon: 139.69
departs: 2027-03-14
rate: 150
data:
  spend:
    source: spend
    compute:
      home: round(local / $this.rate, 2)
    fields:
      item: text
      local: number
panels:
  - view: number
    tab: Plan
    title: Days to go
    source: this
    field: departs
    format: until
    label: until I leave
  - view: checklist
    tab: Plan
    title: Packing
    items: [Passport, Chargers, Plug adapter, Medication, Rain jacket, Cash]
    save: packed
  - view: table
    tab: Itinerary
    title: Itinerary
    source: Trips/Tokyo.ics
    sort: start
    columns: [start, summary, location]
    labels: {start: When, summary: What, location: Where}
  - view: form
    tab: Spending
    title: Spent abroad
    save: spend
    label: Add
  - view: number
    tab: Spending
    title: Spent so far
    source: spend
    field: home
    agg: sum
    format: "$0,0.00"
    label: at the rate in this note
  - view: number
    tab: Spending
    title: Today's rate
    source: https://api.frankfurter.dev/v1/latest?base=USD&symbols=JPY
    pick: rates
    field: JPY
    decimals: 2
    label: yen to the dollar; put the one you'll use in rate
  - view: table
    tab: Spending
    title: Expenses
    source: spend
    sort: -at
    columns: [item, local, home]
    labels: {local: Yen, home: Dollars}
    format: {home: "$0,0.00"}
    edit: [item, local]
  - use: "[[Destination weather]]"
    with: {name: $this.city, lat: $this.lat, lon: $this.lon}
    tab: Weather
---
Change city, lat, lon, departs and rate at the top to plan your own trip, put its bookings in
Trips/Tokyo.ics (any calendar file from a booking email), and log each expense in the local
currency to see it in dollars. It asks to fetch from api.frankfurter.dev, api.open-meteo.com and
archive-api.open-meteo.com, and to read Trips/Tokyo.ics; it needs the note Destination weather.
