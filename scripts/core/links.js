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
