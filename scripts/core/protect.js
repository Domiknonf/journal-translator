/**
 * Protection layer: turns an HTML fragment into a form that is safe to hand to
 * a translation model, and restores it afterwards.
 *
 *  - Every attribute (href, src, class, data-uuid, style, ...) is removed from the
 *    fragment and replaced by a single index attribute `data-k="N"`. The model
 *    never sees image paths, UUIDs or CSS classes, so it cannot alter them.
 *  - Foundry enrichers in text (`@UUID[...]{Label}`, `@Compendium[...]`, `@Embed[...]`,
 *    `&Reference[...]`, `[[/r 1d20]]`, `[[/check dex 15]]{Label}` ...) are replaced
 *    by `<x-e n="N">Label</x-e>`. Only the label is visible to the model and may be
 *    translated; the target is restored verbatim.
 *
 * These functions only depend on standard DOM APIs, so they run in the browser
 * (Foundry) and in Node tests via jsdom.
 */

const TEXT_NODE = 3;
const ELEMENT_NODE = 1;
const SHOW_TEXT = 4;

/** Matches @Word[...]{label}, &Word[...]{label} and [[...]]{label} (label optional). */
export const ENRICHER_RE =
  /(?:[@&][A-Za-z]+\[(?:[^[\]]|\[[^[\]]*\])*\]|\[\[(?:[^[\]]|\[[^[\]]*\])*\]\])(?:\{[^{}]*\})?/g;

export const ATTR = "data-k";
export const ENRICHER_TAG = "x-e";

/** Split an enricher match into its fixed core and its (optional) display label. */
export function splitEnricher(text) {
  if (text.endsWith("}")) {
    const i = text.lastIndexOf("]{");
    if (i !== -1) return { core: text.slice(0, i + 1), label: text.slice(i + 2, -1) };
  }
  return { core: text, label: null };
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

  const walker = doc.createTreeWalker(container, SHOW_TEXT);
  const textNodes = [];
  while (walker.nextNode()) textNodes.push(walker.currentNode);

  for (const node of textNodes) {
    const value = node.nodeValue;
    ENRICHER_RE.lastIndex = 0;
    if (!ENRICHER_RE.test(value)) continue;
    ENRICHER_RE.lastIndex = 0;

    const frag = doc.createDocumentFragment();
    let last = 0;
    for (const m of value.matchAll(ENRICHER_RE)) {
      if (m.index > last) frag.append(doc.createTextNode(value.slice(last, m.index)));
      const { core, label } = splitEnricher(m[0]);
      const ph = doc.createElement(ENRICHER_TAG);
      ph.setAttribute("n", String(enrichers.length));
      if (label) ph.textContent = label;
      enrichers.push({ core, label });
      frag.append(ph);
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

function checkIndices(nodes, attr, expected) {
  if (nodes.length !== expected) return false;
  const seen = new Set();
  for (const n of nodes) {
    const v = n.getAttribute(attr);
    if (!/^\d+$/.test(v ?? "")) return false;
    const i = Number(v);
    if (i >= expected || seen.has(i)) return false;
    seen.add(i);
  }
  return true;
}

/**
 * Validate a translated fragment against the protection state and restore all
 * attributes and enrichers. Returns `{ ok: true, html }` or `{ ok: false, error }`.
 */
export function restore(translated, state, doc) {
  const tpl = doc.createElement("template");
  tpl.innerHTML = String(translated ?? "");
  const root = tpl.content;

  const kNodes = Array.from(root.querySelectorAll(`[${ATTR}]`));
  if (!checkIndices(kNodes, ATTR, state.attrs.length)) {
    return { ok: false, error: `markup mismatch (expected ${state.attrs.length} tagged elements, got ${kNodes.length})` };
  }
  const eNodes = Array.from(root.querySelectorAll(ENRICHER_TAG));
  if (!checkIndices(eNodes, "n", state.enrichers.length)) {
    return { ok: false, error: `link mismatch (expected ${state.enrichers.length} links/rolls, got ${eNodes.length})` };
  }

  for (const el of kNodes) {
    const list = state.attrs[Number(el.getAttribute(ATTR))];
    for (const a of Array.from(el.attributes)) el.removeAttribute(a.name);
    for (const [name, value] of list) el.setAttribute(name, value);
  }

  for (const el of eNodes) {
    const { core, label } = state.enrichers[Number(el.getAttribute("n"))];
    let text = core;
    if (label !== null) {
      const newLabel = el.textContent.replace(/[{}]/g, "").trim();
      text += `{${newLabel || label}}`;
    }
    el.replaceWith(doc.createTextNode(text));
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

export const _internal = { TEXT_NODE, ELEMENT_NODE };
