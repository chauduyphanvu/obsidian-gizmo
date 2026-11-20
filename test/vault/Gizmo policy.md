---
labels:
  "Health/**": private
  Apps/Meds data: private
sinks:
  api.open-meteo.com: public
release:
  - app: Apps/Meds
    panel: Doses today
    to: [pin]
---
How private my notes are, where their data may go, and the one exception: the count of today's
doses may show in the status bar. Gizmo uses this once it's applied from the automation map.
