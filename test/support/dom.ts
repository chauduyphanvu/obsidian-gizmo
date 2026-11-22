// A DOM for tests: linkedom plus the element helpers Obsidian adds to every element
// (createDiv, createEl, setText, empty, addClass...). Import before any code that draws.
import { parseHTML } from "linkedom";

const { window, document } = parseHTML("<!doctype html><html><body></body></html>");

interface Info {
  cls?: string | string[];
  text?: string;
  attr?: Record<string, string | number | boolean | null>;
  type?: string;
  value?: string;
  href?: string;
  title?: string;
}

function apply(el: Element, o?: Info | string): void {
  if (!o) return;
  if (typeof o === "string") { el.className = o; return; }
  if (o.cls) el.className = Array.isArray(o.cls) ? o.cls.join(" ") : o.cls;
  if (o.text !== undefined) el.textContent = o.text;
  for (const [k, v] of Object.entries(o.attr ?? {})) if (v !== null) el.setAttribute(k, String(v));
  for (const k of ["type", "value", "href", "title"] as const) {
    if (o[k] !== undefined) (el as unknown as Record<string, string>)[k] = o[k]!;
  }
}

const split = (cls: string[]) => cls.flatMap((c) => c.split(/\s+/)).filter(Boolean);
// Obsidian adds them to every node; elements and fragments are the ones tests make them on.
const proto = window.Element.prototype as unknown as Record<string, unknown>;
Object.assign(window.DocumentFragment.prototype, {
  createEl(this: DocumentFragment, tag: string, o?: Info | string) {
    const el = this.ownerDocument.createElement(tag);
    apply(el, o);
    this.appendChild(el);
    return el;
  },
  createDiv(this: DocumentFragment & { createEl: Function }, o?: Info | string) { return this.createEl("div", o); },
});
Object.assign(proto, {
  createEl(this: Element, tag: string, o?: Info | string) {
    const el = this.ownerDocument.createElement(tag);
    apply(el, o);
    this.appendChild(el);
    return el;
  },
  createDiv(this: Element & { createEl: Function }, o?: Info | string) { return this.createEl("div", o); },
  createSpan(this: Element & { createEl: Function }, o?: Info | string) { return this.createEl("span", o); },
  empty(this: Element) { while (this.firstChild) this.removeChild(this.firstChild); },
  setText(this: Element, text: string) { this.textContent = text; },
  addClass(this: Element, ...cls: string[]) { this.classList.add(...split(cls)); },
  removeClass(this: Element, ...cls: string[]) { this.classList.remove(...split(cls)); },
  hasClass(this: Element, cls: string) { return this.classList.contains(cls); },
  setAttr(this: Element, name: string, value: string | number | boolean | null) {
    if (value === null) this.removeAttribute(name);
    else this.setAttribute(name, String(value));
  },
});

// linkedom makes forms plain elements that can't reset; empty their fields the way a browser does
// for fields with no default.
Object.assign(window.HTMLElement.prototype, {
  reset(this: Element) {
    for (const el of this.querySelectorAll("input, textarea")) {
      const input = el as HTMLInputElement;
      if (input.type === "checkbox") input.checked = false;
      else input.value = "";
    }
  },
});

// linkedom's checkbox has no `checked` until one is set; a browser's starts from the attribute.
const checked = new WeakMap<Element, boolean>();
Object.defineProperty(window.HTMLInputElement.prototype, "checked", {
  configurable: true,
  get(this: Element) { return checked.get(this) ?? this.hasAttribute("checked"); },
  set(this: Element, value: boolean) { checked.set(this, !!value); },
});

// linkedom doesn't track focus; this is enough of it for tests that check focus is kept.
let focused: Element | null = null;
Object.defineProperty(document, "activeElement", {
  configurable: true,
  get: () => (focused?.isConnected ? focused : document.body),
});
for (const target of [window.Element.prototype, window.HTMLElement.prototype] as unknown as Record<string, unknown>[]) {
  Object.assign(target, {
    focus(this: Element) { focused = this; },
    blur(this: Element) { if (focused === this) focused = null; },
  });
}

// linkedom lays nothing out, so nothing scrolls; each element asked to be shown is kept, with how,
// for tests that check what was brought into view.
const scrolled: { el: Element; options: unknown }[] = [];
Object.assign(window.Element.prototype, {
  scrollIntoView(this: Element, options?: unknown) { scrolled.push({ el: this, options }); },
});

// Obsidian's globals: the document in front (one window here) and a detached div.
const createDiv = (o?: Info | string) => {
  const el = document.createElement("div");
  apply(el, o);
  return el;
};
Object.assign(globalThis, { window, document, activeDocument: document, createDiv });

export { document, scrolled };
