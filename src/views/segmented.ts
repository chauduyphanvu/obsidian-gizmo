/**
 * A segmented control: a few named choices on an inset track, the one chosen raised. It is a tab
 * list: one Tab stop (the choice made), ← → Home End move to another and choose it, and each
 * segment says whether it is chosen. What choosing does is the caller's.
 */
export interface Segmented {
  el: HTMLElement;
  /** Marks a choice as made, without calling back. */
  select(name: string | undefined): void;
}

export function segmented(parent: HTMLElement, names: readonly string[], opts: { cls?: string; segmentCls?: string; label?: string; pick(name: string): void }): Segmented {
  const el = parent.createDiv({ cls: `${opts.cls ? `${opts.cls} ` : ""}gz-segmented`, attr: { role: "tablist", ...(opts.label && { "aria-label": opts.label }) } });
  const buttons = names.map((name) => {
    const b = el.createEl("button", { cls: `${opts.segmentCls ? `${opts.segmentCls} ` : ""}gz-segment`, text: name, attr: { type: "button", role: "tab", "aria-selected": "false", tabindex: "-1" } });
    b.addEventListener("click", () => opts.pick(name));
    return b;
  });
  const select = (name: string | undefined) => {
    for (const [i, b] of buttons.entries()) {
      const on = names[i] === name;
      b.classList.toggle("is-active", on);
      b.setAttribute("aria-selected", String(on));
      b.setAttribute("tabindex", on ? "0" : "-1");
    }
    if (!buttons.some((b) => b.classList.contains("is-active")) && buttons[0]) buttons[0].setAttribute("tabindex", "0");
  };
  el.addEventListener("keydown", (e) => {
    const i = buttons.indexOf(e.target as HTMLButtonElement);
    if (i < 0 || e.altKey || e.ctrlKey || e.metaKey || e.shiftKey) return;
    const to = e.key === "ArrowLeft" ? i - 1 : e.key === "ArrowRight" ? i + 1 : e.key === "Home" ? 0 : e.key === "End" ? buttons.length - 1 : undefined;
    if (to === undefined || !buttons[to]) return;
    e.preventDefault();
    buttons[to].focus();
    opts.pick(names[to]);
  });
  select(undefined);
  return { el, select };
}
