/**
 * Splits an HTML document into translatable segments.
 *
 * A segment is the content of a "leaf block" (a <p>, <h2>, <li>, <td>, ... that has no
 * block-level children). Mixed containers such as `<li>Text <ul>...</ul></li>` have their
 * loose inline runs wrapped in a temporary <span data-jt-run> which becomes its own segment
 * and is unwrapped again by {@link unwrapRuns}.
 */

const BLOCK_TAGS = new Set([
  "address", "article", "aside", "blockquote", "caption", "dd", "details", "div", "dl", "dt",
  "fieldset", "figcaption", "figure", "footer", "form", "h1", "h2", "h3", "h4", "h5", "h6",
  "header", "hgroup", "hr", "li", "main", "nav", "ol", "p", "pre", "section", "summary",
  "table", "tbody", "td", "tfoot", "th", "thead", "tr", "ul"
]);

const SKIP_TAGS = new Set(["pre", "code", "script", "style", "template", "svg", "math", "iframe", "video", "audio"]);

export const RUN_ATTR = "data-jt-run";
const HAS_LETTER = /\p{L}/u;

const tag = (n) => (n.nodeType === 1 ? n.tagName.toLowerCase() : "");
const isBlock = (n) => n.nodeType === 1 && BLOCK_TAGS.has(tag(n));
const hasLetters = (n) => HAS_LETTER.test(n.textContent ?? "");

/** Returns an array of Elements whose innerHTML should be translated. */
export function collectSegments(root) {
  const doc = root.ownerDocument;
  const segments = [];

  const visit = (el) => {
    if (SKIP_TAGS.has(tag(el))) return;
    const kids = Array.from(el.childNodes);
    if (!kids.some(isBlock)) {
      if (hasLetters(el)) segments.push(el);
      return;
    }
    let run = [];
    const flush = () => {
      if (run.some(hasLetters)) {
        const span = doc.createElement("span");
        span.setAttribute(RUN_ATTR, "");
        run[0].before(span);
        span.append(...run);
        segments.push(span);
      }
      run = [];
    };
    for (const n of kids) {
      if (isBlock(n)) {
        flush();
        visit(n);
      } else if (n.nodeType === 1 && SKIP_TAGS.has(tag(n))) {
        flush();
      } else {
        run.push(n);
      }
    }
    flush();
  };

  visit(root);
  return segments;
}

/** Remove the temporary run wrappers created by {@link collectSegments}. */
export function unwrapRuns(root) {
  for (const span of Array.from(root.querySelectorAll(`span[${RUN_ATTR}]`))) {
    span.replaceWith(...Array.from(span.childNodes));
  }
}

export function headings(root) {
  return Array.from(root.querySelectorAll("h1, h2, h3, h4, h5, h6"));
}
