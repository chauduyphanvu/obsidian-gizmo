---
app: Appointments on a day
inputs:
  day: date
view: list
title: On $day
source: notes
from: Health
where: {date: $day}
item: "{name} ({who})"
---
