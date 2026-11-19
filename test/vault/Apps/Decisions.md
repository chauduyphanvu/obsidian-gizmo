---
app: Write down a decision before I know how it turns out, score it later, and see how often I'm right
data:
  decisions:
    source: notes
    from: Decisions
    fields:
      name: {label: Decision}
      expect: {label: I expected}
      confidence: {type: [60, 70, 80, 90, 95], label: "% sure"}
      review: {type: date, label: Due}
      outcome: {type: [open, right, wrong], label: It went, default: open}
      learned: {label: What I learned}
      made: {type: date, label: Written, default: today}
    compute: {hit: 'if(outcome == "right", 1, 0)', said: confidence / 100}
  waiting: {source: decisions, where: {outcome: open}, sort: review}
  due: {source: waiting, where: {review: past}}
  scored: {source: decisions, where: {outcome: "!= open"}}
panels:
  - view: form
    title: A decision I'm making
    fields: [name, expect, confidence, review]
    save: decisions
    label: Write it down
    notify: Written down. Come back on {review} to score it.
    shortcut: decide
  - {view: number, title: Ready to score, source: due, label: decisions whose day has come, alert: "> 0", pin: status}
  - {view: number, title: Right so far, source: scored, agg: share, of: {outcome: right}, label: "of the decisions I've scored"}
tabs:
  Score:
    - {view: table, title: How did these turn out?, source: due, edit: [outcome, learned], format: {review: relative, made: relative}}
  Waiting:
    - view: timeline
      title: Still waiting to find out
      source: waiting
      start: made
      end: review
      detail: "{name}. I expected: {expect} ({confidence}% sure). I'll know by {review}."
  Track record:
    - {view: bar, span: 2, title: "How sure I said I was, and how often I was right", source: scored, group: confidence, y: [said, hit], agg: avg, format: "0%", labels: {said: I said, hit: I was right}}
    - {view: table, span: 2, title: Scored, source: scored, sort: -review, columns: [name, confidence, outcome, learned], edit: true}
---
Before a decision plays out, write what you expect and how sure you are, and pick the day you'll know.
On that day it shows under Score (and in the status bar): mark it right or wrong and note what you
learned. Waiting lists the ones still to come; pick one to read what you expected. Track record then
shows whether "80% sure" really means right four times in five. Each decision is its own note in
Decisions; it asks to read, create and change the properties of notes there.

This is the Decision journal written short: fields carry their labels and defaults, blocks chain,
panels sit in tabs, and the timeline shows the picked decision itself.
