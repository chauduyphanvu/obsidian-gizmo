---
component: Score a decision on its own note, next to what I wrote about it
for: Decisions/
panels:
  - view: text
    source: this
    compute:
      line: 'if(outcome == "open", "I expect: " + expect + " (" + confidence + "% sure). Due " + review + ".", "I expected: " + expect + " (" + confidence + "% sure). It went " + outcome + ".")'
    text: "{line}"
  - view: form
    title: How it turned out
    fields:
      outcome: {type: [open, right, wrong], label: It went}
      learned: {type: textarea, label: What I learned}
      review: {type: date, label: Due}
    save: this
---
A lens: it shows above every note in Decisions, so you can score a decision while reading your own
reasoning below it. It asks to change the properties of notes in Decisions.
