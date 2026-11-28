import assert from "node:assert/strict";
import { test } from "node:test";
import { routeLink } from "../src/link-route.ts";

// What a Gizmo link does, the same in Obsidian (obsidian://gizmo) and in the app (gizmo://open).

test("a link opens Install or Join, the activity log, a capture line or a shortcut's run, by what it carries", () => {
  const did: string[] = [];
  const h = {
    install: (link: string) => did.push(`install ${link}`),
    invite: (text: string) => did.push(`invite ${text}`),
    activity: (id: string) => did.push(`activity ${id}`),
    capture: (p: Record<string, string>) => did.push(`capture ${p.line}`),
    run: (p: Record<string, string>) => did.push(`run ${p.app}#${p.do}${p.line ? ` line=${p.line}` : ""}`),
  };
  routeLink({ install: "https://gist.github.com/a/1" }, h);
  routeLink({ invite: "eyJ2IjoxfQ" }, h);
  routeLink({ activity: "e1" }, h);
  routeLink({ key: "k", line: "water 2" }, h);
  routeLink({ app: "Water", do: "add", line: "a field called line" }, h);
  routeLink({ app: "Water", do: "add" }, h);
  assert.deepEqual(did, [
    "install https://gist.github.com/a/1", "invite eyJ2IjoxfQ", "activity e1", "capture water 2",
    "run Water#add line=a field called line", "run Water#add",
  ]);
});
