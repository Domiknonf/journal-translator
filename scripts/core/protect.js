/**
 * Protection layer: turns an HTML fragment into a form that is safe to hand to
 * a translation model, and restores it afterwards.
 *
 *  - Every attribute (href, src, class, data-uuid, style, ...) is removed from the
 *    fragment and replaced by a single index attribute `data-k="N"`. The model
 *    never sees image paths, UUIDs or CSS classes, so it cannot alter them.
 *  - Foundry enrichers in text (`@UUID[...]{Label}`, `@Compendium[...]`, `@Embed[...]`,
 *    `&Reference[...]`, `[[/r 1d20]]`, `[[/check dex 15]]{Label}` ...) are replaced:
 *      - with a label:    `<x-e n="N">Label</x-e>` (the label is translated)
 *      - without a label: the visible marker `⟦N⟧` (models tend to drop empty tags,
 *        but reliably keep visible markers)
 *    The enricher itself is restored verbatim.
 *
 * These functions only depend on standard DOM APIs, so they run in the browser
 * (Foundry) and in Node tests via jsdom.
 */

const SHOW_TEXT = 4;

/** Matches @Word[...]{label}, &Word[...]{label} and [[...]]{label} (label optional). */
export const ENRICHER_RE =
  /(?:[@&][A-Za-z]+\[(?:[^[\]]|\[[^[\]]*\])*\]|\[\[(?:[^[\]]|\[[^[\]]*\])*\]\])(?:\{[^{}]*\})?/g;

export const ATTR = "data-k";
export const ENRICHER_TAG = "x-e";
export const MARKER_RE = /⟦(\d+)⟧/g;
export const marker = (i) => `⟦${i}⟧`;

const VOID_TAGS = new Set(["area", "base", "br", "col", "embed", "hr", "img", "input", "link", "meta", "source", "track", "wbr"]);

/** Split an enricher match into its fixed core and its (optional) display label. */
export function splitEnricher(text) {
  if (text.endsWith("}")) {
    const i = text.lastIndexOf("]{");
    if (i !== -1) return { core: text.slice(0, i + 1), label: text.slice(i + 2, -1) };
  }
  return { core: text, label: null };
}

function textNodesOf(root, doc) {
  const walker = doc.createTreeWalker(root, SHOW_TEXT);
  const nodes = [];
  while (walker.nextNode()) nodes.push(walker.currentNode);
  return nodes;
}

/**
 * Protect the *children* of `container` in place (the container itself is left alone).
 * Returns the state needed by {@link restore}.
 */
export function protect(container) {
  const doc = container.ownerDocument;
  const attrs = [];
  const enrichers = [];

  for (const el of Array.from(container.querySelectorAll("*"))) {
    if (!el.attributes.length) continue;
    const list = Array.from(el.attributes, (a) => [a.name, a.value]);
    for (const [name] of list) el.removeAttribute(name);
    el.setAttribute(ATTR, String(attrs.length));
    attrs.push(list);
  }

  for (const node of textNodesOf(container, doc)) {
    const value = node.nodeValue;
    ENRICHER_RE.lastIndex = 0;
    if (!ENRICHER_RE.test(value)) continue;
    ENRICHER_RE.lastIndex = 0;

    const frag = doc.createDocumentFragment();
    let last = 0;
    for (const m of value.matchAll(ENRICHER_RE)) {
      if (m.index > last) frag.append(doc.createTextNode(value.slice(last, m.index)));
      const { core, label } = splitEnricher(m[0]);
      const n = enrichers.length;
      if (label !== null && label.trim()) {
        const ph = doc.createElement(ENRICHER_TAG);
        ph.setAttribute("n", String(n));
        ph.textContent = label;
        frag.append(ph);
      } else {
        frag.append(doc.createTextNode(marker(n)));
      }
      enrichers.push({ core, label });
      last = m.index + m[0].length;
    }
    if (last < value.length) frag.append(doc.createTextNode(value.slice(last)));
    node.replaceWith(frag);
  }

  return { attrs, enrichers };
}

/** Convenience: protect a copy of `el`'s content and return the HTML to translate. */
export function protectElement(el) {
  const clone = el.cloneNode(true);
  const state = protect(clone);
  return { html: clone.innerHTML, state };
}

/** True if `values` contains every index of `expected` exactly once and nothing else. */
function sameIndices(values, expected) {
  if (values.length !== expected.size) return false;
  const seen = new Set();
  for (const v of values) {
    if (!/^\d+$/.test(v ?? "")) return false;
    const i = Number(v);
    if (!expected.has(i) || seen.has(i)) return false;
    seen.add(i);
  }
  return true;
}

/**
 * Models sometimes write `<x-e n="1"/>` or `<span data-k="2"/>`. In HTML a "/>" does not
 * close a non-void element, so it would swallow the following text. Expand those.
 */
export function expandSelfClosing(html) {
  return html.replace(/<([A-Za-z][\w-]*)(\s[^<>]*?)?\s*\/>/g, (m, tag, attrs = "") =>
    VOID_TAGS.has(tag.toLowerCase()) ? m : `<${tag}${attrs}></${tag}>`
  );
}

/**
 * Validate a translated fragment against the protection state and restore all
 * attributes and enrichers. Returns `{ ok: true, html }` or `{ ok: false, error }`.
 */
export function restore(translated, state, doc) {
  const tpl = doc.createElement("template");
  tpl.innerHTML = expandSelfClosing(String(translated ?? ""));
  const root = tpl.content;

  const all = (n) => new Set(Array.from({ length: n }, (_, i) => i));
  const kNodes = Array.from(root.querySelectorAll(`[${ATTR}]`));
  if (!sameIndices(kNodes.map((n) => n.getAttribute(ATTR)), all(state.attrs.length))) {
    return { ok: false, error: `markup mismatch (expected ${state.attrs.length} tagged elements, got ${kNodes.length})` };
  }

  const labeled = new Set();
  const markers = new Set();
  state.enrichers.forEach((e, i) => (e.label !== null && e.label.trim() ? labeled : markers).add(i));

  const eNodes = Array.from(root.querySelectorAll(ENRICHER_TAG));
  if (!sameIndices(eNodes.map((n) => n.getAttribute("n")), labeled)) {
    return { ok: false, error: `link mismatch (expected ${labeled.size} labelled links, got ${eNodes.length})` };
  }
  const found = [];
  for (const t of textNodesOf(root, doc)) for (const m of t.nodeValue.matchAll(MARKER_RE)) found.push(m[1]);
  if (!sameIndices(found, markers)) {
    return { ok: false, error: `marker mismatch (expected ${[...markers].map(marker).join(" ")}, got ${found.map(marker).join(" ") || "none"})` };
  }

  for (const el of kNodes) {
    const list = state.attrs[Number(el.getAttribute(ATTR))];
    for (const a of Array.from(el.attributes)) el.removeAttribute(a.name);
    for (const [name, value] of list) el.setAttribute(name, value);
  }

  for (const el of eNodes) {
    const { core, label } = state.enrichers[Number(el.getAttribute("n"))];
    const newLabel = el.textContent.replace(/[{}]/g, "").replace(MARKER_RE, "").trim();
    el.replaceWith(doc.createTextNode(`${core}{${newLabel || label}}`));
  }

  for (const t of textNodesOf(root, doc)) {
    MARKER_RE.lastIndex = 0;
    if (!MARKER_RE.test(t.nodeValue)) continue;
    t.nodeValue = t.nodeValue.replace(MARKER_RE, (m, i) => state.enrichers[Number(i)].core);
  }

  const holder = doc.createElement("div");
  holder.append(root);
  return { ok: true, html: holder.innerHTML };
}

/** Escape plain text (e.g. a document name) so it can travel through the same pipeline. */
export function escapeText(text, doc) {
  const d = doc.createElement("div");
  d.textContent = text;
  return d.innerHTML;
}

/** Convert a translated plain-text segment back to text. */
export function toPlainText(html, doc) {
  const tpl = doc.createElement("template");
  tpl.innerHTML = String(html ?? "");
  return tpl.content.textContent.replace(/\s+/g, " ").trim();
}
