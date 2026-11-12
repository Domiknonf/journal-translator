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
import { translateItems, countRequests } from "./core/translator.js";
import { rewriteLinks, defaultSlugify } from "./core/links.js";

const F = {
  original: "original",          // JournalEntry: { name, pages: { [id]: { name, content, caption } } }
  nameDone: "translatedName",    // JournalEntry: true
  done: "translated",            // JournalEntryPage: true
  anchors: "anchors",            // JournalEntryPage: [[oldSlug, newSlug], ...]
  translation: "translation"     // JournalEntry: translation saved by "restore original" (same shape)
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
            check(out) {
              const r = restore(out, state, doc());
              if (r.ok) return r.html;
              this.lastError = r.error;
              this.lastOutput = out;
              return null;
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
    const { name, pages } = snapshot(entry);
    await entry.setFlag(MODULE_ID, F.original, { name, pages });
    // A translation stored by "restore original" is superseded by the new run.
    if (hasTranslation(entry)) await entry.unsetFlag(MODULE_ID, F.translation);
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

/**
 * Count the exact input tokens a run would send (provider tokenizer or counting API) and
 * estimate the output tokens. Nothing is generated, so this costs nothing.
 */
export async function countEntries(entries, { force = false, signal } = {}) {
  const { items } = prepareWork(entries, { force });
  return countRequests(items, {
    provider: createProvider(),
    maxChars: getSetting("maxChars"),
    prompt: promptOptions(),
    signal
  });
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

/** Current state of an entry, including the per-page translation status. */
function snapshot(entry) {
  const pages = {};
  for (const p of entry.pages) {
    pages[p.id] = {
      name: p.name,
      content: p.text?.content ?? null,
      caption: p.image?.caption ?? null,
      done: !!p.getFlag(MODULE_ID, F.done),
      anchors: p.getFlag(MODULE_ID, F.anchors) ?? []
    };
  }
  return { name: entry.name, nameDone: !!entry.getFlag(MODULE_ID, F.nameDone), pages };
}

/** Write a snapshot back. Pages added after the snapshot was taken are left alone. */
async function applySnapshot(entry, snap) {
  const updates = [];
  for (const page of entry.pages) {
    const s = snap.pages?.[page.id];
    if (!s) continue;
    const u = {
      _id: page.id,
      name: s.name,
      [`flags.${MODULE_ID}.${F.done}`]: !!s.done,
      [`flags.${MODULE_ID}.${F.anchors}`]: s.anchors ?? []
    };
    if (s.content !== null && page.type === "text") u["text.content"] = s.content;
    if (s.caption !== null && page.type === "image") u["image.caption"] = s.caption;
    updates.push(u);
  }
  if (updates.length) await entry.updateEmbeddedDocuments("JournalEntryPage", updates);
  await entry.update({ name: snap.name, [`flags.${MODULE_ID}.${F.nameDone}`]: !!snap.nameDone });
}

export function hasTranslation(entry) {
  return !!entry.getFlag(MODULE_ID, F.translation);
}

/**
 * Restore the original text of an entry translated in place. The translation is kept,
 * so it can be brought back with {@link restoreTranslation} without translating again.
 */
export async function restoreEntry(entry) {
  const backup = entry.getFlag(MODULE_ID, F.original);
  if (!backup) return false;
  const translation = snapshot(entry);
  await applySnapshot(entry, { ...backup, nameDone: false });
  await entry.setFlag(MODULE_ID, F.translation, translation);
  await entry.unsetFlag(MODULE_ID, F.original);
  return true;
}

/**
 * Bring back the translation saved by {@link restoreEntry}. The current (original) text is
 * saved as the new backup, so edits made to it in the meantime are not lost.
 */
export async function restoreTranslation(entry) {
  const translation = entry.getFlag(MODULE_ID, F.translation);
  if (!translation) return false;
  const original = snapshot(entry);
  await entry.setFlag(MODULE_ID, F.original, { name: original.name, pages: original.pages });
  await applySnapshot(entry, translation);
  await entry.unsetFlag(MODULE_ID, F.translation);
  return true;
}

export { providerConfig };
