import assert from "node:assert/strict";
import { test } from "node:test";
import { DataLayer } from "../src/datalayer.ts";
import { askersOf, checkPanel, describePermission, permissionsOf, readSpec, resolvePanel, type Panel } from "../src/spec.ts";
import { fakeHost } from "./support/fakes.ts";

const FILES = { appPath: "Apps/G.md", dataPath: "Apps/G data.md" };
const NOW = new Date(2026, 10, 18, 12, 0);
const GQL = "https://api.example.com/graphql";
const QUERY = "query($term: String!) { search(term: $term) { id title } }";

const panelOf = (keys: Record<string, unknown>): Panel => readSpec({ app: "x", ...keys })!.spec!.panels[0].panel;
const load = (dl: DataLayer, p: Panel) => dl.panelData(p.source, p, FILES, { ttlMs: 60_000, now: NOW });

test("a map body is sent as JSON in a POST", async () => {
  const f = fakeHost();
  const dl = new DataLayer(f.host);
  const p = panelOf({ view: "table", source: GQL, body: { query: "{ launches { name } }", variables: { limit: 5, ids: [1, 2] } } });
  await load(dl, p);
  assert.equal(f.calls.length, 1);
  const [call] = f.calls;
  assert.equal(call.url, GQL);
  assert.equal(call.method, "POST");
  assert.equal(call.headers["content-type"], "application/json");
  assert.deepEqual(JSON.parse(call.body!), { query: "{ launches { name } }", variables: { limit: 5, ids: [1, 2] } });
});

test("a text body is sent as typed, with no content type of its own", async () => {
  const f = fakeHost();
  const dl = new DataLayer(f.host);
  await load(dl, panelOf({ view: "table", source: GQL, body: "term=dune&limit=5" }));
  assert.deepEqual(f.calls.map((c) => [c.method, c.body, c.headers]), [["POST", "term=dune&limit=5", {}]]);
});

test("the author's own content type wins, however it is spelled", async () => {
  const f = fakeHost();
  const dl = new DataLayer(f.host);
  await load(dl, panelOf({ view: "table", source: GQL, headers: { "Content-Type": "application/graphql+json" }, body: { query: "{ a }" } }));
  assert.deepEqual(f.calls[0].headers, { "Content-Type": "application/graphql+json" });
  assert.deepEqual(JSON.parse(f.calls[0].body!), { query: "{ a }" });
});

test("a GET stays a GET", async () => {
  const f = fakeHost();
  await load(new DataLayer(f.host), panelOf({ view: "table", source: GQL }));
  assert.deepEqual(f.calls.map((c) => [c.method, c.body]), [["GET", undefined]]);
});

test("panels with the same URL and body share one request; another body is another request", async () => {
  const f = fakeHost();
  const dl = new DataLayer(f.host);
  const a = panelOf({ view: "table", source: GQL, body: { query: "{ a }" } });
  const sameAsA = panelOf({ view: "number", source: GQL, body: { query: "{ a }" }, field: "current.t" });
  const b = panelOf({ view: "table", source: GQL, body: { query: "{ b }" } });
  const get = panelOf({ view: "table", source: GQL });
  await Promise.all([a, sameAsA].map((p) => load(dl, p)));
  assert.equal(f.calls.length, 1);
  await Promise.all([a, b, get].map((p) => load(dl, p)));
  assert.deepEqual(f.calls.map((c) => c.body), [JSON.stringify({ query: "{ a }" }), JSON.stringify({ query: "{ b }" }), undefined]);
});

test("refreshing a URL drops its responses whatever the body", async () => {
  const f = fakeHost();
  const dl = new DataLayer(f.host);
  const a = panelOf({ view: "table", source: GQL, body: { query: "{ a }" } });
  const b = panelOf({ view: "table", source: GQL, body: "x" });
  await Promise.all([load(dl, a), load(dl, b)]);
  await Promise.all([load(dl, a), load(dl, b)]);
  assert.equal(f.calls.length, 2);
  assert.deepEqual(dl.depsOf(a.source, a, FILES), [`url:${GQL}`]);
  dl.forgetUrls([GQL]);
  await Promise.all([load(dl, a), load(dl, b)]);
  assert.equal(f.calls.length, 4);
});

test("a secret typed in a body is filled into its value at request time, and keeps the JSON valid", async () => {
  const f = fakeHost();
  f.secrets.demo = 'a"b\\c';
  const dl = new DataLayer(f.host);
  await load(dl, panelOf({ view: "table", source: GQL, body: { auth: { token: "Bearer {secret:demo}" }, n: 1 } }));
  assert.deepEqual(JSON.parse(f.calls[0].body!), { auth: { token: 'Bearer a"b\\c' }, n: 1 });
  await assert.rejects(load(dl, panelOf({ view: "table", source: GQL, body: { token: "{secret:nope}" } })), /Missing secret "nope"/);
  assert.equal(f.calls.length, 1);
});

test("a body asks for permission to send it, and for the secrets in it", () => {
  const spec = (keys: Record<string, unknown>) => readSpec({ app: "x", view: "table", ...keys }, { path: "Apps/G.md" })!.spec!;
  assert.deepEqual(permissionsOf(spec({ source: GQL }), "Apps/G.md"), ["net:api.example.com"]);
  assert.deepEqual(permissionsOf(spec({ source: GQL, body: { query: "{ a }" } }), "Apps/G.md"), ["net:api.example.com", "post:api.example.com"]);
  assert.deepEqual(permissionsOf(spec({ source: GQL, body: "q={secret:demo}" }), "Apps/G.md"), ["net:api.example.com", "post:api.example.com", "secret:demo"]);
  const asked = askersOf(spec({ source: GQL, body: { t: "{secret:demo}" } }), "Apps/G.md");
  assert.deepEqual([...asked.keys()], ["net:api.example.com", "post:api.example.com", "secret:demo"]);
  assert.equal(describePermission("post:api.example.com"), "Send a request body to api.example.com");
});

test("body needs a URL source, and is text or a set of keys", () => {
  const BODY = { query: "{ a }" };
  assert.deepEqual(checkPanel({ view: "table", source: GQL, body: BODY }, true).errors, []);
  assert.deepEqual(checkPanel({ view: "table", source: GQL, body: "q=1" }, true).errors, []);
  for (const source of ["doses", "notes", "Finance/bank.csv"]) {
    const keys = { view: "table", source, body: BODY, ...(source === "notes" ? { from: "Books" } : {}) };
    assert.deepEqual(checkPanel(keys, true).errors, ['"body" needs a URL source'], source);
  }
  assert.deepEqual(checkPanel({ view: "table", source: GQL, body: ["a"] }, true).errors, ['"body" has the wrong type (expected text or a set of keys)']);
  assert.deepEqual(checkPanel({ view: "form", fields: { a: "text" }, save: "x", body: BODY }, true).errors, ['"body" doesn\'t apply to form']);
});

test("a data block holds the body with its URL; blocks further down the chain can't", () => {
  const r = readSpec({ app: "x", data: {
    search: { source: GQL, body: { query: QUERY }, pick: "data.search" },
    big: { source: "search", where: { id: "> 5" } },
  }, panels: [{ view: "table", source: "big" }] })!;
  assert.deepEqual(r.errors, []);
  assert.deepEqual(r.spec!.panels[0].panel.body, { query: QUERY });
  assert.equal(r.spec!.panels[0].panel.source, GQL);
  const bad = readSpec({ app: "x", data: {
    search: { source: GQL },
    big: { source: "search", body: { query: "{ a }" } },
  }, panels: [{ view: "table", source: "big" }] })!;
  assert.deepEqual(bad.errors, ['data.big: "body" belongs on data.search, where the source is']);
});

const search = (value: unknown) => {
  const ps = readSpec({ app: "x", inputs: { q: "text" }, panels: [
    { view: "table", source: GQL, body: { query: QUERY, variables: { term: "$q", page: 1 } } },
  ] })!.spec!.panels[0];
  return resolvePanel(ps, { q: value });
};

test("a typed name is filled into a body as a value, so quotes, braces and backslashes stay inside it", async () => {
  const typed = 'say "hi" {x} C:\\dir \u00e9';
  const r = search(typed);
  assert.deepEqual(r.errors, []);
  assert.deepEqual(r.panel!.body, { query: QUERY, variables: { term: typed, page: 1 } });
  const f = fakeHost();
  await load(new DataLayer(f.host), r.panel!);
  assert.deepEqual(JSON.parse(f.calls[0].body!), { query: QUERY, variables: { term: typed, page: 1 } });
  // The query's own $term was never a declared name, so it stayed as written.
  assert.ok(f.calls[0].body!.includes("$term"));
});

test("a name in a text body is refused: nothing would escape it there; a map body takes it as a value", () => {
  // A refused panel isn't drawn, so its input is also reported as unused; that isn't what is checked here.
  const read = (fm: Record<string, unknown>) => {
    const r = readSpec({ app: "x", view: "table", source: GQL, ...fm })!;
    return { ...r, errors: r.errors.filter((e) => !e.endsWith("isn't used by any panel")) };
  };
  assert.deepEqual(read({ inputs: { q: "text" }, body: "term=$q&limit=5" }).errors, ["write body as a map to use $q in it, e.g. body: {q: $q}"]);
  assert.deepEqual(read({ inputs: { q: "text" }, body: '{"q":"$q"}' }).errors, ["write body as a map to use $q in it, e.g. body: {q: $q}"]);
  assert.deepEqual(read({ body: "near=$this.city" }).errors, ["write body as a map to use $this.city in it, e.g. body: {city: $this.city}"]);
  assert.deepEqual(read({ inputs: { k: ["a", "b"] }, body: "kind=$k" }).errors, ["write body as a map to use $k in it, e.g. body: {k: $k}"]);
  // A component's param, whatever it holds, the same.
  const notes = { "C.md": { component: "c", params: ["term"], panels: [{ view: "table", source: GQL, body: "term=$term" }] } };
  const reader = { resolve: (l: string) => (`${l}.md` in notes ? `${l}.md` : undefined), frontmatter: (p: string) => (notes as Record<string, Record<string, unknown>>)[p] };
  assert.deepEqual(readSpec({ app: "x", panels: [{ use: "[[C]]", with: { term: "dune" } }] }, { notes: reader })!.errors,
    ["panel 1 (from [[C]] panel 1): write body as a map to use $term in it, e.g. body: {term: $term}"]);
  // Text without names, a map with them, and one name as the whole body (a value, not text around it) are fine.
  assert.deepEqual(read({ body: "term=dune&limit=5" }).errors, []);
  assert.deepEqual(read({ inputs: { q: "text" }, body: "$q" }).errors, []);
  const ps = read({ inputs: { q: "text" }, body: { term: "$q", limit: 5 } }).spec!.panels[0];
  assert.deepEqual(resolvePanel(ps, { q: 'du"ne' }).panel!.body, { term: 'du"ne', limit: 5 });
});

test("a typed value with a secret placeholder or a line break is refused, not sent", () => {
  for (const bad of ["{secret:demo}", "x {secret:demo} y", "two\nlines", "carriage\rreturn", 'quote " and\nbreak']) {
    const r = search(bad);
    assert.equal(r.panel, undefined, JSON.stringify(bad));
    assert.deepEqual(r.errors, ["$q can't hold a secret or a line break"], JSON.stringify(bad));
  }
  assert.deepEqual(search('quote " alone').errors, []);
});

test("a name can't build a secret's id in a body, and a typed secret can still be used", () => {
  const named = readSpec({ app: "x", inputs: { k: ["demo"] }, view: "table", source: GQL, body: { token: "{secret:$k}" } })!;
  assert.ok(named.errors.includes("$k can't name a secret"), named.errors.join("; "));
  const fine = readSpec({ app: "x", inputs: { q: "text" }, view: "table", source: GQL, body: { token: "{secret:demo}", term: "$q" } })!;
  assert.deepEqual(fine.errors, []);
});
