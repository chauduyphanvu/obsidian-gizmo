---
app: See whether my weight, blood pressure, pulse and sleep are moving the right way, and take the numbers to an appointment
weight_target: 80
systolic_target: 130
diastolic_target: 80
pulse_target: 75
sleep_target: 7
data:
  readings:
    source: "[[Measurement]]"
    compute:
      target: 'if(what == "weight", $this.weight_target, if(what == "systolic", $this.systolic_target, if(what == "diastolic", $this.diastolic_target, if(what == "pulse", $this.pulse_target, $this.sleep_target))))'
      off: 'if(what == "sleep", value < target, value > target)'
      rank: 'if(what == "weight", 1, if(what == "systolic", 2, if(what == "diastolic", 3, if(what == "pulse", 4, 5))))'
  reading_rows:
    source: readings
  weight:
    source: readings
    where: {what: weight}
    sort: at
  weight_rows:
    source: weight
  pulse:
    source: readings
    where: {what: pulse}
    sort: at
  sleep:
    source: readings
    where: {what: sleep}
  sleep_rows:
    source: sleep
  in_order:
    source: readings
    sort: at
  by_measure:
    source: in_order
    sort: what
  measures:
    source: by_measure
    compute:
      first: prev(what) != what
      ago: days(at, today())
      n30: if(first, 0, prev(n30)) + if(ago < 30, 1, 0)
      s30: if(first, 0, prev(s30)) + if(ago < 30, value, 0)
      low30: min(if(first, "", prev(low30)), if(ago < 30, value, ""))
      high30: max(if(first, "", prev(high30)), if(ago < 30, value, ""))
      off30: if(first, 0, prev(off30)) + if(ago < 30 && off, 1, 0)
      n90: if(first, 0, prev(n90)) + if(ago < 90, 1, 0)
      s90: if(first, 0, prev(s90)) + if(ago < 90, value, 0)
      low90: min(if(first, "", prev(low90)), if(ago < 90, value, ""))
      high90: max(if(first, "", prev(high90)), if(ago < 90, value, ""))
      off90: if(first, 0, prev(off90)) + if(ago < 90 && off, 1, 0)
      nb: if(first, 0, prev(nb)) + if(ago >= 30 && ago < 60, 1, 0)
      sb: if(first, 0, prev(sb)) + if(ago >= 30 && ago < 60, value, 0)
      avg30: if(n30 > 0, round(s30 / n30, 1), "")
      avg90: if(n90 > 0, round(s90 / n90, 1), "")
      range30: if(n30 > 0, text(low30) + " to " + text(high30), "")
      range90: if(n90 > 0, text(low90) + " to " + text(high90), "")
      change: if(n30 > 0 && nb > 0, round(s30 / n30 - sb / nb, 1), "")
      moved: 'if(change == "", "", if(change == 0, "steady", if(change < 0, "down ", "up ") + text(abs(change)) + if((change < 0) == (what != "sleep"), ", the right way", ", the wrong way")))'
    group: rank
  pressure:
    source: in_order
    compute:
      n: coalesce(prev(n), 0) + 1
      bp: what == "systolic" || what == "diastolic" || what == "pulse"
      sitting: 'date(at) + if(hour(at) < 12, " morning", " evening")'
      sys: 'if(what == "systolic", value, "")'
      dia: 'if(what == "diastolic", value, "")'
      pul: 'if(what == "pulse", value, "")'
      last_sys: if(what == "systolic", value, prev(last_sys))
      last_dia: if(what == "diastolic", value, prev(last_dia))
      high: last_sys > $this.systolic_target || last_dia > $this.diastolic_target
      in30: days(at, today()) < 30
      n_sys: coalesce(prev(n_sys), 0) + if(in30 && what == "systolic", 1, 0)
      t_sys: coalesce(prev(t_sys), 0) + if(in30 && what == "systolic", value, 0)
      n_dia: coalesce(prev(n_dia), 0) + if(in30 && what == "diastolic", 1, 0)
      t_dia: coalesce(prev(t_dia), 0) + if(in30 && what == "diastolic", value, 0)
      avg_sys: if(n_sys > 0, round(t_sys / n_sys), "")
      avg_dia: if(n_dia > 0, round(t_dia / n_dia), "")
    where: {bp: true}
  pressure_rows:
    source: pressure
tabs:
  Now:
    - view: number
      title: Weight
      source: weight
      field: value
      agg: last
      unit: kg
      decimals: 1
      label: latest
      alert: "> $this.weight_target"
    - view: text
      title: Blood pressure
      source: pressure_rows
      sort: -n
      limit: 1
      text: "{last_sys}/{last_dia}"
      label: latest, systolic over diastolic
      alert: {high: true}
      empty: Nothing logged yet
    - view: number
      title: Pulse
      source: pulse
      field: value
      agg: last
      unit: bpm
      label: latest
      alert: "> $this.pulse_target"
    - view: number
      title: Sleep
      source: sleep_rows
      where: {at: last 7 days}
      field: value
      agg: avg
      unit: hours
      decimals: 1
      compare: previous
      label: a night, this week
      alert: "< $this.sleep_target"
    - view: form
      title: Weighed in
      save: "[[Measurement]]"
      fields: [value, note]
      labels: {value: kg}
      row: {what: weight, value: "{value}", note: "{note}"}
      label: Log
      alias: weight
    - view: form
      title: Took a reading
      save: "[[Measurement]]"
      fields: [what, value, note]
      label: Log
      alias: reading
    - view: reconcile
      title: From my health export, not checked yet
      source: "[[Measurement]]"
      empty: Nothing from your health export waits. Export it as CSV into Inbox/Health.
    - view: table
      title: Each measure
      source: measures
      agg: last
      columns: [what, value, avg30, moved, target]
      labels: {what: Measure, value: Latest, avg30: Last 30 days, moved: Against the 30 before, target: Target}
      empty: Nothing measured yet. Weigh in above, or export your phone's health data into Inbox/Health.
    - view: line
      title: Weight, last 90 days
      source: weight_rows
      where: {at: last 90 days}
      x: at
      y: value
      unit: kg
      goal: $this.weight_target
    - view: table
      title: Blood pressure, each sitting
      source: pressure_rows
      group: sitting
      agg: avg
      columns: [sitting, sys, dia, pul]
      sort: -sitting
      limit: 8
      labels: {sitting: Sitting, sys: Systolic, dia: Diastolic, pul: Pulse}
      format: {sys: "0", dia: "0", pul: "0"}
      empty: No blood pressure yet. Type a reading's two numbers, e.g. systolic 128, then diastolic 82.
    - view: table
      title: Recent
      source: reading_rows
      sort: -at
      limit: 12
      columns: [at, what, value, note]
      labels: {at: When, what: Measure, value: Value, note: Note}
      format: {at: relative}
      edit: [value, note]
  For the appointment:
    - view: number
      title: Weight, last 30 days
      source: weight_rows
      where: {at: last 30 days}
      field: value
      agg: avg
      unit: kg
      decimals: 1
      compare: previous
      label: on average
    - view: text
      title: Blood pressure, last 30 days
      source: pressure_rows
      sort: -n
      limit: 1
      text: "{avg_sys}/{avg_dia}"
      label: on average, systolic over diastolic
      empty: Nothing logged yet
    - view: table
      title: Each measure, last 30 days
      source: measures
      agg: last
      columns: [what, n30, avg30, range30, off30]
      labels: {what: Measure, n30: Readings, avg30: Average, range30: Range, off30: Off target}
      empty: Nothing measured in the last 30 days.
    - view: table
      title: Each measure, last 90 days
      source: measures
      agg: last
      columns: [what, n90, avg90, range90, off90]
      labels: {what: Measure, n90: Readings, avg90: Average, range90: Range, off90: Off target}
      empty: Nothing measured in the last 90 days.
    - view: table
      title: Off target, last 90 days
      source: reading_rows
      where: {at: last 90 days, off: true}
      sort: -at
      columns: [at, what, value, target]
      labels: {at: When, what: Measure, value: Value, target: Target}
      format: {at: date}
      empty: No reading off its target in the last 90 days.
    - view: table
      title: Blood pressure, each sitting, last 30 days
      source: pressure_rows
      where: {at: last 30 days}
      group: sitting
      agg: avg
      columns: [sitting, sys, dia, pul]
      sort: -sitting
      labels: {sitting: Sitting, sys: Systolic, dia: Diastolic, pul: Pulse}
      format: {sys: "0", dia: "0", pul: "0"}
      empty: No blood pressure in the last 30 days.
    - view: table
      title: What I noted
      source: reading_rows
      compute:
        noted: len(trim(coalesce(note, ""))) > 0
      where: {noted: true, at: last 90 days}
      sort: -at
      columns: [at, what, value, note]
      labels: {at: When, what: Measure, value: Value, note: Note}
      format: {at: date}
      empty: No notes in the last 90 days. Add one after the number, e.g. weight 80.4 after a big dinner.
expect:
  - id: weigh-in
    every: day
    by: "10:00"
    source: weight
    say: no weigh-in by 10:00
  - id: blood-pressure
    every: week
    by: "sun 20:00"
    source: readings
    where: {what: systolic}
    say: no blood pressure this week
---
Made-up numbers to start with; type your own over them or import your export. Each number is a row
of the kind Measurement. Weigh in with `weight 79.8` in Gizmo: Do… or on the line here; any other
number goes on the second line with its measure, `sleep 7.5`, `pulse 64`. A blood pressure reading
is its two numbers, `systolic 128` and then `diastolic 82` (and the cuff's `pulse`): Vitals puts the
numbers taken in one morning or evening side by side, and averages two readings taken together.
Export your phone's health data as CSV into Inbox/Health: its readings wait under From my health
export until you check them, and one you already typed pairs with it rather than counting twice.

The targets are the properties at the top: at or under them for weight, blood pressure and pulse,
at or over for sleep; change them there. Each number up top tells you when it is off its target, as
does Each measure, which also says whether the last 30 days moved the right way against the 30
before. Gizmo: Next asks for a weigh-in each morning by 10:00 and a blood pressure reading each
week. For the appointment sums up the last 30 and 90 days, measure by measure: how many readings,
the average, the range and how many were off target, then each one off target, each blood pressure
sitting and what you noted. It tracks numbers; it says nothing about what they mean for your
health, so take them to the person who looks after it. It asks to read and change the rows of
Measurement.
