/* csv-workbench — a Polars→WebAssembly CSV cleaning workbench that runs entirely
   in the browser. The engine (the `data` crate compiled to wasm) lives in a Web
   Worker (web/worker.js); this file is the UI: a windowed data table + a tools
   panel of cleaning operations, with non-destructive undo/redo. Built with
   web-kit components + tokens; the DOM is built with el() — no innerHTML. */
import { el } from "../../web-kit/src/el";
import { button } from "../../web-kit/src/components/button";
import { iconButton } from "../../web-kit/src/components/iconButton";
import { select } from "../../web-kit/src/components/select";
import { stat } from "../../web-kit/src/components/stat";
import { emptyState } from "../../web-kit/src/components/emptyState";

// ---------- types ----------
interface ColumnMeta {
  name: string;
  dtype: string;
  semantic_dtype: string;
  null_pct: number | null;
  unique_pct: number | null;
  sample: string | null;
}
interface Step {
  kind: string;
  params: Record<string, unknown>;
}
interface Page {
  columns: string[];
  rows: (string | null)[][];
  total: number;
}
interface Field {
  key: string;
  type: "text" | "enum" | "bool" | "sentinels";
  label: string;
  options?: [string, string][];
  default?: string | boolean;
  placeholder?: string;
}
interface OpDef {
  id: string;
  label: string;
  scope: "global" | "column";
  min?: number;
  max?: number;
  fields: Field[];
  build: (sel: string[], v: Record<string, string | boolean>) => Step[];
}

const step = (kind: string, params: Record<string, unknown>): Step => ({ kind, params });

// ---------- the cleaning catalog (each id = the engine's step kind) ----------
const OPS: OpDef[] = [
  { id: "snake_case_columns", label: "snake_case headers", scope: "global", fields: [], build: () => [step("snake_case_columns", {})] },
  { id: "replace_in_names", label: "Replace in names…", scope: "global",
    fields: [{ key: "find", type: "text", label: "Find" }, { key: "replace", type: "text", label: "Replace with", placeholder: "(blank to remove)" }],
    build: (_s, v) => [step("replace_in_names", { find: v.find ?? "", replace: v.replace ?? "" })] },
  { id: "change_case", label: "Change case…", scope: "global",
    fields: [{ key: "mode", type: "enum", label: "Case", options: [["lower", "lowercase"], ["upper", "UPPERCASE"]], default: "lower" }],
    build: (_s, v) => [step("change_case", { mode: v.mode ?? "lower" })] },
  { id: "unwrap_csv", label: "Unwrap embedded CSV", scope: "global", fields: [], build: () => [step("unwrap_csv", {})] },

  { id: "drop_columns", label: "Delete selected", scope: "column", min: 1, fields: [], build: (sel) => [step("drop_columns", { cols: sel })] },
  { id: "filter_columns", label: "Keep only selected", scope: "column", min: 1, fields: [], build: (sel) => [step("filter_columns", { cols: sel })] },
  { id: "drop_nulls", label: "Drop rows with empty", scope: "column", min: 1, fields: [], build: (sel) => [step("drop_nulls", { cols: sel })] },
  { id: "fill_nulls", label: "Fill empties…", scope: "column", min: 1,
    fields: [{ key: "strategy", type: "enum", label: "With", options: [["fixed", "a value"], ["forward", "previous value"], ["zero", "zero"]], default: "fixed" }, { key: "value", type: "text", label: "Value", placeholder: 'when "a value"' }],
    build: (sel, v) => sel.map((c) => step("fill_nulls", { column: c, strategy: v.strategy ?? "fixed", value: v.value ?? "" })) },
  { id: "replace_text", label: "Find & replace…", scope: "column", min: 1, max: 1,
    fields: [{ key: "find", type: "text", label: "Find" }, { key: "replace", type: "text", label: "Replace with", placeholder: "(blank to remove)" }, { key: "is_regex", type: "bool", label: "Regular expression", default: false }],
    build: (sel, v) => [step("replace_text", { column: sel[0], find: v.find ?? "", replace: v.replace ?? "", is_regex: !!v.is_regex })] },
  { id: "cast", label: "Change type…", scope: "column", min: 1, max: 1,
    fields: [{ key: "dtype", type: "enum", label: "To type", options: [["str", "Text"], ["int", "Integer"], ["float", "Decimal"], ["bool", "Boolean"], ["date", "Date"]], default: "str" }],
    build: (sel, v) => [step("cast", { column: sel[0], dtype: v.dtype ?? "str" })] },
  { id: "rename_column", label: "Rename…", scope: "column", min: 1, max: 1,
    fields: [{ key: "to", type: "text", label: "New name" }],
    build: (sel, v) => [step("rename_column", { from: sel[0], to: v.to ?? "" })] },
  { id: "split_column", label: "Split…", scope: "column", min: 1, max: 1,
    fields: [{ key: "sep", type: "text", label: "Separator", default: "," }, { key: "keep_original", type: "bool", label: "Keep original column", default: false }],
    build: (sel, v) => [step("split_column", { column: sel[0], sep: v.sep ?? ",", keep_original: !!v.keep_original })] },
  { id: "join_columns", label: "Combine…", scope: "column", min: 2, max: 2,
    fields: [{ key: "sep", type: "text", label: "Separator", default: " " }, { key: "new_name", type: "text", label: "New column name" }],
    build: (sel, v) => [step("join_columns", { col1: sel[0], col2: sel[1], sep: v.sep ?? " ", new_name: (v.new_name as string) || `${sel[0]}_${sel[1]}` })] },
  { id: "format_dates", label: "Format dates…", scope: "column", min: 1, max: 1,
    fields: [{ key: "fmt", type: "text", label: "Format", default: "%Y-%m-%d", placeholder: "%Y-%m-%d" }, { key: "on_incomplete", type: "enum", label: "If unparseable", options: [["null", "blank it"], ["drop", "drop the row"], ["keep", "keep as-is"]], default: "null" }],
    build: (sel, v) => [step("format_dates", { column: sel[0], fmt: (v.fmt as string) || "%Y-%m-%d", on_incomplete: v.on_incomplete ?? "null" })] },
  { id: "fix_invalid", label: "Fix invalid…", scope: "column", min: 1,
    fields: [{ key: "sentinels", type: "sentinels", label: "Treat as invalid", placeholder: "N/A, -, ??? …" }],
    build: (sel, v) => [step("fix_invalid", { columns: sel, sentinels: String(v.sentinels ?? "").split(",").map((s) => s.trim()).filter(Boolean) })] },
];
const GLOBAL_OPS = OPS.filter((o) => o.scope === "global");
const COLUMN_OPS = OPS.filter((o) => o.scope === "column");
const opEnabled = (o: OpDef, n: number): boolean => o.scope === "global" || (n >= (o.min ?? 1) && n <= (o.max ?? Infinity));

// ---------- worker client ----------
let worker!: Worker;
let seq = 0;
const inflight = new Map<number, { resolve: (v: unknown) => void; reject: (e: Error) => void }>();
function engineCall<T = unknown>(op: string, payload?: unknown): Promise<T> {
  return new Promise<T>((resolve, reject) => {
    const id = ++seq;
    inflight.set(id, { resolve: resolve as (v: unknown) => void, reject });
    worker.postMessage({ id, op, payload });
  });
}

// ---------- state ----------
const PAGE_LIMIT = 200;
let cols: ColumnMeta[] = [];
const applied: Step[] = [];
const redo: Step[][] = [];
const selection = new Set<string>();
let sort: { col: string; ascending: boolean } | null = null;
let offset = 0;
let totalRows = 0;
let cleanness: number | null = null;
let activeOp: OpDef | null = null; // op whose action-sheet is open

const byId = (id: string): HTMLElement => document.getElementById(id) as HTMLElement;
/** replaceChildren that drops nullish/false children (unlike the native one). */
function setKids(host: HTMLElement, ...kids: (Node | string | null | undefined | false)[]): void {
  host.replaceChildren(...kids.filter((k): k is Node | string => k != null && k !== false));
}

// ---------- import / refresh ----------
async function openFile(file: File | undefined): Promise<void> {
  if (!file) return;
  setStatus(`Parsing ${file.name}…`);
  const buf = await file.arrayBuffer();
  try {
    const dims = await engineCall<{ rows: number; cols: number }>("load", { bytes: buf, tld: undefined });
    applied.length = 0; redo.length = 0; selection.clear(); sort = null; offset = 0;
    totalRows = dims.rows;
    await refresh();
    setStatus("");
  } catch (e) {
    setStatus(`Could not parse: ${(e as Error).message}`);
  }
}

// Re-derive the current frame (set_steps), then repaint headers + table + score.
async function refresh(): Promise<void> {
  const dims = await engineCall<{ rows: number; cols: number }>("set_steps", { steps: JSON.stringify(applied) });
  totalRows = dims.rows;
  cols = JSON.parse(await engineCall<string>("columns_meta"));
  // prune selection / sort that no longer exist
  const names = new Set(cols.map((c) => c.name));
  for (const s of [...selection]) if (!names.has(s)) selection.delete(s);
  if (sort && !names.has(sort.col)) sort = null;
  if (offset >= totalRows) offset = 0;
  renderTools();
  await renderTable();
  rescore();
}

async function rescore(): Promise<void> {
  try {
    const rep = JSON.parse(await engineCall<string>("score")) as { score: number | null };
    cleanness = rep.score;
  } catch {
    cleanness = null;
  }
  renderChip();
}

// ---------- ops ----------
function stageSteps(steps: Step[]): void {
  applied.push(...steps);
  redo.length = 0;
  activeOp = null;
  void refresh();
}
function runOp(op: OpDef, values: Record<string, string | boolean>): void {
  const sel = [...selection];
  if (!opEnabled(op, sel.length)) return;
  stageSteps(op.build(sel, values));
}
function undo(): void {
  if (!applied.length) return;
  // pop the last logical action — fill_nulls can be a run of same-kind steps,
  // but for simplicity each undo removes one step; group-undo is a v2 nicety.
  redo.push([applied.pop() as Step]);
  void refresh();
}
function redoAction(): void {
  const grp = redo.pop();
  if (!grp) return;
  applied.push(...grp);
  void refresh();
}
async function exportCsv(): Promise<void> {
  const csv = await engineCall<string>("to_csv");
  const blob = new Blob([csv], { type: "text/csv" });
  const a = el("a", { href: URL.createObjectURL(blob), download: "cleaned.csv" });
  a.click();
  URL.revokeObjectURL(a.href);
}

// ---------- rendering: table ----------
async function renderTable(): Promise<void> {
  const host = byId("table");
  if (!cols.length) {
    host.replaceChildren(emptyState({
      dropzone: true, glyph: "▦",
      lead: "Open a CSV — it stays on your device.",
      description: "Parsed and cleaned entirely in your browser by a Polars→WebAssembly engine. Nothing is uploaded.",
    }));
    return;
  }
  const query = sort ? JSON.stringify({ sort: [{ col: sort.col, ascending: sort.ascending }] }) : null;
  const page = JSON.parse(await engineCall<string>("view", { query, offset, limit: PAGE_LIMIT })) as Page;

  const headRow = el("tr");
  page.columns.forEach((name) => {
    const meta = cols.find((c) => c.name === name);
    const indicator = sort?.col === name ? (sort.ascending ? " ▲" : " ▼") : "";
    const th = el("th", {},
      el("span", { class: "th-name" }, name),
      meta ? el("span", { class: `dtype dtype-${meta.dtype}` }, meta.dtype) : null,
      indicator);
    th.addEventListener("click", () => {
      if (sort?.col === name) sort = { col: name, ascending: !sort.ascending };
      else sort = { col: name, ascending: true };
      void renderTable();
    });
    headRow.append(th);
  });

  const body = el("tbody");
  for (const row of page.rows) {
    const tr = el("tr");
    row.forEach((cell) => tr.append(el("td", { class: cell == null ? "null" : "" }, cell == null ? "—" : cell)));
    body.append(tr);
  }
  host.replaceChildren(el("div", { class: "wrap" }, el("table", {}, el("thead", {}, headRow), body)));
  renderPager(page.total);
}

function renderPager(total: number): void {
  const to = Math.min(offset + PAGE_LIMIT, total);
  setKids(byId("count"),
    el("span", {}, `${total.toLocaleString()} rows × ${cols.length} cols`),
    el("span", { class: "muted" }, total ? `  ·  showing ${offset + 1}–${to}` : ""),
    total > PAGE_LIMIT ? iconButton("‹", { label: "previous page", size: "sm", onClick: () => { if (offset > 0) { offset = Math.max(0, offset - PAGE_LIMIT); void renderTable(); } } }) : null,
    total > PAGE_LIMIT ? iconButton("›", { label: "next page", size: "sm", onClick: () => { if (offset + PAGE_LIMIT < total) { offset += PAGE_LIMIT; void renderTable(); } } }) : null,
  );
}

// ---------- rendering: tools panel ----------
function renderTools(): void {
  const host = byId("tools");
  if (!cols.length) { host.replaceChildren(); return; }
  const n = selection.size;

  // column list
  const list = el("div", { class: "col-list" });
  cols.forEach((c) => {
    const cb = el("input", { type: "checkbox", checked: selection.has(c.name) }) as HTMLInputElement;
    cb.addEventListener("change", () => { cb.checked ? selection.add(c.name) : selection.delete(c.name); renderTools(); });
    const nullBadge = c.null_pct && c.null_pct > 0 ? el("span", { class: "col-null" }, `${Math.round(c.null_pct)}% empty`) : null;
    list.append(el("label", { class: "col-row" }, cb,
      el("span", { class: "col-name" }, c.name),
      el("span", { class: `dtype dtype-${c.dtype}` }, c.dtype), nullBadge));
  });

  const opBtn = (op: OpDef): HTMLElement => {
    const enabled = opEnabled(op, n);
    return button(op.label, {
      variant: activeOp?.id === op.id ? "primary" : "secondary", size: "sm", disabled: !enabled,
      onClick: () => { if (op.fields.length) { activeOp = activeOp?.id === op.id ? null : op; renderTools(); } else runOp(op, {}); },
    });
  };

  setKids(host,
    el("div", { class: "tools-head" }, el("h2", {}, "Tools"),
      el("span", { class: "spacer" }),
      n ? button(`Clear (${n})`, { variant: "ghost", size: "sm", onClick: () => { selection.clear(); activeOp = null; renderTools(); } }) : null),
    el("div", { class: "tools-section" }, el("h3", {}, "Columns"), list),
    el("div", { class: "tools-section" }, el("h3", {}, "Whole file"), el("div", { class: "op-grid" }, ...GLOBAL_OPS.map(opBtn))),
    el("div", { class: "tools-section" },
      el("h3", {}, "Selected columns", n ? el("span", { class: "sel-count" }, ` · ${n} selected`) : null),
      el("div", { class: "op-grid" }, ...COLUMN_OPS.map(opBtn))),
    activeOp ? actionSheet(activeOp) : null,
  );
}

function actionSheet(op: OpDef): HTMLElement {
  const values: Record<string, string | boolean> = {};
  op.fields.forEach((f) => { if (f.default !== undefined) values[f.key] = f.default; });
  const controls = op.fields.map((f) => {
    if (f.type === "enum") {
      const field = select({ size: "sm", children: (f.options ?? []).map(([val, lab]) => el("option", { value: val, selected: val === f.default }, lab)) });
      const sel = field.querySelector("select") as HTMLSelectElement;
      values[f.key] = sel.value;
      sel.addEventListener("change", () => { values[f.key] = sel.value; });
      return el("label", { class: "field" }, el("span", {}, f.label), field);
    }
    if (f.type === "bool") {
      const cb = el("input", { type: "checkbox", checked: !!f.default }) as HTMLInputElement;
      cb.addEventListener("change", () => { values[f.key] = cb.checked; });
      return el("label", { class: "field field-bool" }, cb, el("span", {}, f.label));
    }
    const inp = el("input", { class: "field-input", type: "text", placeholder: f.placeholder ?? "", value: (f.default as string) ?? "" }) as HTMLInputElement;
    inp.addEventListener("input", () => { values[f.key] = inp.value; });
    return el("label", { class: "field" }, el("span", {}, f.label), inp);
  });
  return el("div", { class: "sheet" },
    el("div", { class: "sheet-title" }, op.label),
    ...controls,
    el("div", { class: "sheet-actions" },
      button("Cancel", { variant: "ghost", size: "sm", onClick: () => { activeOp = null; renderTools(); } }),
      button("Apply", { variant: "primary", size: "sm", onClick: () => runOp(op, values) })));
}

// ---------- chrome ----------
function renderChip(): void {
  const host = byId("chip");
  host.replaceChildren(
    cleanness != null ? stat(`${Math.round(cleanness)}%`, { label: "clean", size: "sm", tone: cleanness >= 80 ? "success" : "default" }) : el("span", {}),
  );
}
function setStatus(msg: string): void { byId("status").textContent = msg; }

function buildChrome(): void {
  const file = el("input", { type: "file", accept: ".csv,text/csv" }) as HTMLInputElement;
  file.hidden = true;
  file.addEventListener("change", () => void openFile(file.files?.[0]));

  const header = el("header", { class: "app-header" },
    el("h1", {}, "csv-workbench"),
    el("span", { class: "muted" }, "clean & transform CSVs in your browser"),
    el("span", { id: "status", class: "status" }),
    el("span", { class: "spacer" }),
    el("span", { id: "chip", class: "chip" }),
    iconButton("↶", { label: "undo", size: "sm", onClick: undo }),
    iconButton("↷", { label: "redo", size: "sm", onClick: redoAction }),
    button("Open CSV", { variant: "primary", onClick: () => file.click() }),
    button("Export CSV", { onClick: () => void exportCsv() }),
    file);

  byId("root").append(
    header,
    el("div", { id: "count", class: "count" }),
    el("main", { class: "layout" }, el("section", { id: "table", class: "table-pane" }), el("aside", { id: "tools", class: "tools-pane" })));
}

// ---------- init ----------
window.addEventListener("DOMContentLoaded", () => {
  worker = new Worker(new URL("worker.js", location.href).href);
  worker.onmessage = (e: MessageEvent) => {
    const { id, ok, result, error } = e.data as { id: number; ok: boolean; result: unknown; error: string };
    const p = inflight.get(id);
    if (!p) return;
    inflight.delete(id);
    ok ? p.resolve(result) : p.reject(new Error(error));
  };
  buildChrome();
  void renderTable(); // empty state
  document.addEventListener("dragover", (e) => e.preventDefault());
  document.addEventListener("drop", (e) => { e.preventDefault(); void openFile(e.dataTransfer?.files?.[0]); });
});
