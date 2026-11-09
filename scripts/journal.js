/**
 * Foundry integration: reads journal entries, runs the translation and writes the result back.
 *
 * Mode "inplace" (default): translates the entries themselves. Before the first change the
 * original text is stored in a flag on the entry, so it can be restored at any time and a
 * later run always translates from the original. Scene map pins, links from actors and
 * every other reference keep working because the document IDs do not change.
 *
 * Mode "copy": duplicates the entries (page IDs are kept) into a new folder and translates
 * the copies. Links between the copied entries are redirected to the copies.
 *
 * Every page is saved as soon as it is finished, so an interrupted run can simply be started
 * again; finished pages are skipped unless "force" is set.
 */

import { MODULE_ID, getSetting, createProvider, providerConfig } from "./settings.js";
import { protectElement, restore, escapeText, toPlainText } from "./core/protect.js";
import { collectSegments, unwrapRuns, headings } from "./core/segment.js";
import { translateItems, estimate } from "./core/translator.js";
import { rewriteLinks, defaultSlugify } from "./core/links.js";

const F = {
  original: "original",          // JournalEntry: { name, pages: { [id]: { name, content, caption } } }
  nameDone: "translatedName",    // JournalEntry: true
  done: "translated",            // JournalEntryPage: true
  anchors: "anchors"             // JournalEntryPage: [[oldSlug, newSlug], ...]
};

function slugifyHeading(el) {
  const cls = CONFIG.JournalEntryPage?.documentClass;
  try {
    if (typeof cls?.slugifyHeading === "function") return cls.slugifyHeading(el);
  } catch { /* fall through */ }
  const text = el.textContent ?? "";
  return typeof text.slugify === "function" ? text.slugify({ strict: true }) : defaultSlugify(text);
}

// An inert document: parsing HTML here neither loads images nor runs inline handlers.
let inertDoc = null;
const doc = () => (inertDoc ??= document.implementation.createHTMLDocument(""));

const plainItem = (id, text, context, onDone) => ({
  id,
  html: escapeText(text, doc()),
  context,
  check: (out) => {
    const t = toPlainText(out, doc());
    return t ? t : null;
  },
  onDone
});

export function hasBackup(entry) {
  return !!entry.getFlag(MODULE_ID, F.original);
}

/** Build the list of translation items and the bookkeeping to save pages when they finish. */
export function prepareWork(entries, { force = false } = {}) {
  const items = [];
  const pageWorks = [];
  const nameUpdates = [];

  for (const entry of entries) {
    const backup = entry.getFlag(MODULE_ID, F.original);
    const entryName = backup?.name ?? entry.name;

    if (force || !entry.getFlag(MODULE_ID, F.nameDone)) {
      items.push(plainItem(`${entry.uuid}::name`, entryName, "Journal titles", (value) => {
        if (value) nameUpdates.push(entry.update({ name: value, [`flags.${MODULE_ID}.${F.nameDone}`]: true }));
      }));
    }

    const pages = entry.pages.contents.slice().sort((a, b) => a.sort - b.sort);
    for (const page of pages) {
      if (!force && page.getFlag(MODULE_ID, F.done)) continue;
      const orig = backup?.pages?.[page.id];
      const pageName = orig?.name ?? page.name;
      const context = `${entryName} / ${pageName}`;
      const work = { entry, page, pending: 0, failed: 0, update: {}, root: null, headingEls: [], oldSlugs: [] };

      const track = (item, apply) => {
        work.pending++;
        item.onDone = (value) => {
          if (value !== null && value !== undefined) apply(value);
          else work.failed++;
        };
        item.work = work;
        items.push(item);
      };

      track(plainItem(`${page.uuid}::name`, pageName, context), (v) => { work.update.name = v; });

      if (page.type === "text") {
        const root = doc().createElement("div");
        root.innerHTML = orig?.content ?? page.text?.content ?? "";
        work.root = root;
        work.headingEls = headings(root);
        work.oldSlugs = work.headingEls.map(slugifyHeading);
        collectSegments(root).forEach((el, i) => {
          const { html, state } = protectElement(el);
          track({
            id: `${page.uuid}::${i}`,
            html,
            context,
            check: (out) => {
              const r = restore(out, state, doc());
              return r.ok ? r.html : null;
            }
          }, (v) => { el.innerHTML = v; });
        });
      } else if (page.type === "image") {
        const caption = orig?.caption ?? page.image?.caption;
        if (caption) track(plainItem(`${page.uuid}::caption`, caption, context), (v) => { work.update["image.caption"] = v; });
      }
      pageWorks.push(work);
    }
  }
  return { items, pageWorks, nameUpdates };
}

async function finalizePage(work) {
  // A page with failed segments is saved (partially translated) but not marked as done,
  // so the next run translates it again.
  const update = { ...work.update, [`flags.${MODULE_ID}.${F.done}`]: work.failed === 0 };
  if (work.root) {
    const anchors = [];
    work.headingEls.forEach((el, i) => {
      const oldSlug = work.oldSlugs[i];
      const newSlug = slugifyHeading(el);
      if (oldSlug && newSlug && oldSlug !== newSlug) anchors.push([oldSlug, newSlug]);
    });
    unwrapRuns(work.root);
    update["text.content"] = work.root.innerHTML;
    update[`flags.${MODULE_ID}.${F.anchors}`] = anchors;
  }
  await work.page.update(update);
}

async function ensureBackups(entries) {
  for (const entry of entries) {
    if (hasBackup(entry)) continue;
    const pages = {};
    for (const p of entry.pages) {
      pages[p.id] = { name: p.name, content: p.text?.content ?? null, caption: p.image?.caption ?? null };
    }
    await entry.setFlag(MODULE_ID, F.original, { name: entry.name, pages });
  }
}

async function copyEntries(entries) {
  const target = getSetting("targetLanguage");
  const folder = await Folder.create({
    name: `${game.i18n.localize("JOURNAL_TRANSLATOR.CopyFolder")} (${target})`,
    type: "JournalEntry"
  });
  const idMap = new Map();
  const copies = [];
  for (const entry of entries) {
    const data = entry.toObject();
    delete data._id;
    data.folder = folder.id;
    if (data.flags?.[MODULE_ID]) delete data.flags[MODULE_ID];
    for (const p of data.pages ?? []) if (p.flags?.[MODULE_ID]) delete p.flags[MODULE_ID];
    const copy = await JournalEntry.create(data, { keepEmbeddedIds: true });
    idMap.set(entry.id, copy.id);
    copies.push(copy);
  }
  return { copies, idMap };
}

/** Fix anchors (and, for copies, entry IDs) in all text pages of the given entries. */
export async function relinkEntries(entries, idMap = new Map()) {
  const anchors = new Map();
  for (const entry of entries) {
    for (const page of entry.pages) {
      const list = page.getFlag(MODULE_ID, F.anchors);
      if (list?.length) anchors.set(`${entry.id}.${page.id}`, new Map(list));
    }
  }
  if (!anchors.size && !idMap.size) return 0;
  let changed = 0;
  for (const entry of entries) {
    const updates = [];
    for (const page of entry.pages) {
      if (page.type !== "text" || !page.text?.content) continue;
      const content = rewriteLinks(page.text.content, { entryId: entry.id, entryIdMap: idMap, anchors });
      if (content !== page.text.content) updates.push({ _id: page.id, "text.content": content });
    }
    if (updates.length) {
      await entry.updateEmbeddedDocuments("JournalEntryPage", updates);
      changed += updates.length;
    }
  }
  return changed;
}

function promptOptions() {
  return {
    sourceLanguage: getSetting("sourceLanguage"),
    targetLanguage: getSetting("targetLanguage"),
    glossary: getSetting("glossary"),
    instructions: getSetting("instructions")
  };
}

export function estimateEntries(entries, { force = false } = {}) {
  const { items } = prepareWork(entries, { force });
  return estimate(items, { maxChars: getSetting("maxChars"), prompt: promptOptions() });
}

/**
 * Translate the given entries.
 * @returns {Promise<{done:number,total:number,failed:number,usage:object,entries:JournalEntry[]}>}
 */
export async function translateEntries(entries, { mode = "inplace", force = false, signal, onProgress } = {}) {
  const provider = createProvider();
  let idMap = new Map();
  if (mode === "copy") {
    ({ copies: entries, idMap } = await copyEntries(entries));
  } else {
    await ensureBackups(entries);
  }

  const { items, nameUpdates } = prepareWork(entries, { force });
  const saves = [];
  let result;
  try {
    result = await translateItems({
      provider,
      items,
      prompt: promptOptions(),
      maxChars: getSetting("maxChars"),
      concurrency: getSetting("concurrency"),
      signal,
      onProgress,
      onItem: (item, value) => {
        item.onDone?.(value);
        const work = item.work;
        if (work && --work.pending === 0) saves.push(finalizePage(work));
      }
    });
  } finally {
    // Save whatever is complete, also when cancelled or a fatal error occurs.
    await Promise.allSettled([...saves, ...nameUpdates]);
  }
  await relinkEntries(entries, idMap);
  return { ...result, entries };
}

/** Restore the original text of an entry translated in place. */
export async function restoreEntry(entry) {
  const backup = entry.getFlag(MODULE_ID, F.original);
  if (!backup) return false;
  const updates = [];
  for (const page of entry.pages) {
    const orig = backup.pages?.[page.id];
    if (!orig) continue;
    const u = {
      _id: page.id,
      name: orig.name,
      [`flags.${MODULE_ID}.${F.done}`]: false,
      [`flags.${MODULE_ID}.${F.anchors}`]: []
    };
    if (orig.content !== null && page.type === "text") u["text.content"] = orig.content;
    if (orig.caption !== null && page.type === "image") u["image.caption"] = orig.caption;
    updates.push(u);
  }
  if (updates.length) await entry.updateEmbeddedDocuments("JournalEntryPage", updates);
  await entry.update({ name: backup.name, [`flags.${MODULE_ID}.${F.nameDone}`]: false });
  await entry.unsetFlag(MODULE_ID, F.original);
  return true;
}

export { providerConfig };
