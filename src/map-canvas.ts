import { fnv1a } from "./hash.ts";
import type { AppSummary } from "./map.ts";
import { permissionTarget } from "./permissions.ts";

interface CanvasNode {
  id: string;
  type: "file" | "text";
  file?: string;
  text?: string;
  x: number;
  y: number;
  width: number;
  height: number;
  color?: string;
}

interface CanvasEdge {
  id: string;
  fromNode: string;
  fromSide: "left" | "right" | "top" | "bottom";
  toNode: string;
  toSide: "left" | "right" | "top" | "bottom";
  label?: string;
}

export interface CanvasData {
  nodes: CanvasNode[];
  edges: CanvasEdge[];
}

const W = 300;
const H = 120;
const GAP = 40;
const COLUMN = 900;

/** A canvas id from a key: the same apps make the same ids, so two saved maps can be compared. */
function idOf(key: string): string {
  return fnv1a(key).toString(16).padStart(8, "0") + fnv1a(key, 0x01000193).toString(16).padStart(8, "0");
}


/**
 * The automation map as an Obsidian canvas: what apps read and fetch on the left, the apps in the
 * middle, what they change and send to on the right, and a line for each `then` between apps.
 * `exists` says whether a note is there, so a data note not made yet is a text card, not a broken file card.
 */
export function mapCanvas(apps: AppSummary[], exists: (path: string) => boolean): CanvasData {
  const sorted = [...apps].sort((a, b) => a.name.localeCompare(b.name) || a.path.localeCompare(b.path));
  const nodes: CanvasNode[] = [];
  const edges: CanvasEdge[] = [];
  const left = new Map<string, CanvasNode>();
  const right = new Map<string, CanvasNode>();
  const node = (column: Map<string, CanvasNode>, x: number, key: string, file: string | undefined, text: string): CanvasNode => {
    let n = column.get(key);
    if (!n) {
      n = file && exists(file)
        ? { id: idOf(`${x}:${key}`), type: "file", file, x, y: 0, width: W, height: H }
        : { id: idOf(`${x}:${key}`), type: "text", text: file ?? text, x, y: 0, width: W, height: 60 };
      column.set(key, n);
    }
    return n;
  };
  const edge = (from: CanvasNode, to: CanvasNode, label: string, fromSide: CanvasEdge["fromSide"] = "right", toSide: CanvasEdge["toSide"] = "left") => {
    const id = idOf(`${from.id}>${to.id}>${label}`);
    if (!edges.some((e) => e.id === id)) edges.push({ id, fromNode: from.id, fromSide, toNode: to.id, toSide, ...(label ? { label } : {}) });
  };

  const appNodes = new Map(sorted.map((a, i): [string, CanvasNode] => [a.path, { id: idOf(`app:${a.path}`), type: "file", file: a.path, x: COLUMN, y: i * (H + GAP), width: W, height: H, color: "4" }]));
  for (const a of sorted) {
    const me = appNodes.get(a.path)!;
    // Every app has a data note; its line goes unlabelled so the others stand out.
    const data = node(right, 2 * COLUMN, `file:${a.dataPath}`, a.dataPath, a.dataPath);
    edge(me, data, "");
    for (const perm of a.wanted) {
      const t = permissionTarget(perm);
      if (!t) continue;
      if (t.side === "in") edge(node(left, 0, t.key, t.file, t.text), me, t.label);
      else edge(me, node(right, 2 * COLUMN, t.key, t.file, t.text), t.label);
    }
    for (const t of [...a.thens, ...a.alerts.flatMap((al) => (al.then ? [al.then] : []))]) {
      const to = t.path ? appNodes.get(t.path) : undefined;
      if (to && to !== me) edge(me, to, `then: ${t.do}`, "bottom", "top");
    }
  }
  // A side card sits level with the apps it is drawn to, pushed down only as far as the card above needs.
  const ys = new Map([...appNodes.values()].map((n) => [n.id, n.y]));
  for (const column of [left, right]) {
    const wanted = (n: CanvasNode) => {
      const linked = edges.flatMap((e) => (e.fromNode === n.id ? [e.toNode] : e.toNode === n.id ? [e.fromNode] : [])).map((id) => ys.get(id)!).filter((y) => y !== undefined);
      return linked.length ? linked.reduce((a, b) => a + b, 0) / linked.length : 0;
    };
    let next = 0;
    for (const n of [...column.values()].map((n) => ({ n, y: wanted(n) })).sort((a, b) => a.y - b.y)) {
      n.n.y = Math.max(n.y, next);
      next = n.n.y + n.n.height + GAP;
    }
  }
  nodes.push(...left.values(), ...appNodes.values(), ...right.values());
  return { nodes, edges };
}
