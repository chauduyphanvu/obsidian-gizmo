---
component: Write down what I expect before I know how it turns out, score it later, and see how often I'm right
params: {folder: Decisions}
data:
  decisions:
    source: notes
    from: $folder
    fields:
      name: {label: What}
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
    title: Before I know
    fields: [name, expect, confidence, review]
    save: decisions
    label: Write it down
    notify: Written down. Come back on {review} to score it.
    shortcut: decide
  - {view: number, title: $folder to score, source: due, label: whose day has come, alert: "> 0", pin: status}
  - {view: number, title: Right so far, source: scored, agg: share, of: {outcome: right}, label: "of the ones I've scored"}
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
The Decisions app as a kit: a whole app in one component, for any folder of notes. Use it with the
folder its notes live in, and it asks to read, create and change the properties of notes there:

    app: Bets I've made with friends
    use: "[[Decision kit]]"
    with: {folder: Bets}

Opened on its own it runs on Decisions, its default.
