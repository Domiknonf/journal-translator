/**
 * Cross-reference maintenance after translation.
 *
 * Foundry anchors (`@UUID[JournalEntry.x.JournalEntryPage.y#some-heading]`) are slugs of
 * the heading text. Translating headings changes the slugs, so links into translated pages
 * have to be rewritten. When translating into copies, links to the original journal
 * entries are additionally redirected to the copies.
 */

const ENRICHER_TARGET_RE = /(@[A-Za-z]+\[)([^\]]*)(\])/g;
const PAGE_RE = /JournalEntryPage\.([A-Za-z0-9]{16})/;
const ENTRY_RE = /(^|\.)JournalEntry\.([A-Za-z0-9]{16})/;

const ENRICHER_ALL_RE =
  /@([A-Za-z]+)\[((?:[^[\]]|\[[^[\]]*\])*)\](?:\{([^{}]*)\})?/g;

/** All @Word[target]{label} enrichers in stored page HTML. */
export function findEnrichers(html) {
  return Array.from(String(html ?? "").matchAll(ENRICHER_ALL_RE), (m) => ({
    raw: m[0],
    kind: m[1],
    target: m[2],
    core: `@${m[1]}[${m[2]}]`,
    label: m[3] ?? null,
    index: m.index
  }));
}

/**
 * Put back the original labels of links for which `keep(core)` is true (e.g. links to maps
 * and creatures), using the original page HTML. Links are matched by their target, in order.
 */
export function restoreLabels(translatedHtml, originalHtml, keep) {
  const queues = new Map();
  for (const e of findEnrichers(originalHtml)) {
    if (e.label === null || !keep(e.core)) continue;
    if (!queues.has(e.core)) queues.set(e.core, []);
    queues.get(e.core).push(e.label);
  }
  if (!queues.size) return translatedHtml;
  const first = new Map([...queues].map(([k, v]) => [k, v[0]]));
  return String(translatedHtml).replace(ENRICHER_ALL_RE, (m, kind, target, label) => {
    const core = `@${kind}[${target}]`;
    if (label === undefined || !queues.has(core)) return m;
    const original = queues.get(core).shift() ?? first.get(core);
    return `${core}{${original}}`;
  });
}

/** Default slug function, mirroring Foundry's `String#slugify({strict: true})`. */
export function defaultSlugify(text) {
  return String(text)
    .normalize("NFD")
    .replace(/[̀-ͯ]/g, "")
    .trim()
    .toLowerCase()
    .replace(/\s+/g, "-")
    .replace(/[^a-z0-9-]/g, "")
    .replace(/-+/g, "-")
    .replace(/^-|-$/g, "");
}

/**
 * Rewrite enricher targets inside `content`.
 * @param {string} content
 * @param {object} ctx
 * @param {string} ctx.entryId                    id of the entry that owns `content` (for relative links)
 * @param {Map<string,string>} [ctx.entryIdMap]   original entry id -> copy id
 * @param {Map<string, Map<string,string>>} [ctx.anchors]  "entryId.pageId" -> (old slug -> new slug)
 */
export function rewriteLinks(content, { entryId, entryIdMap = new Map(), anchors = new Map() }) {
  return content.replace(ENRICHER_TARGET_RE, (m, open, target, close) => {
    const sp = target.indexOf(" ");
    let ref = sp === -1 ? target : target.slice(0, sp);
    const rest = sp === -1 ? "" : target.slice(sp);
    const hashAt = ref.indexOf("#");
    let uuid = hashAt === -1 ? ref : ref.slice(0, hashAt);
    let hash = hashAt === -1 ? null : ref.slice(hashAt + 1);

    // Redirect links to original entries onto their copies (world documents only).
    if (!uuid.startsWith("Compendium.")) {
      uuid = uuid.replace(ENTRY_RE, (all, pre, id) => `${pre}JournalEntry.${entryIdMap.get(id) ?? id}`);
    }

    if (hash !== null) {
      let targetEntry = null;
      let targetPage = null;
      const pm = uuid.match(PAGE_RE);
      if (pm) {
        targetPage = pm[1];
        const em = uuid.match(ENTRY_RE);
        targetEntry = em ? em[2] : entryId;
      } else if (/^\.[A-Za-z0-9]{16}$/.test(uuid)) {
        targetPage = uuid.slice(1);
        targetEntry = entryId;
      }
      const map = targetPage ? anchors.get(`${targetEntry}.${targetPage}`) : null;
      if (map?.has(hash)) hash = map.get(hash);
    }

    ref = hash === null ? uuid : `${uuid}#${hash}`;
    return `${open}${ref}${rest}${close}`;
  });
}
