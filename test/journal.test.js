// End-to-end test of the Foundry glue with minimal fake Foundry documents and a fake API.
import { test } from "node:test";
import assert from "node:assert/strict";
import { JSDOM } from "jsdom";

const { window } = new JSDOM("<!doctype html><body></body>");
globalThis.document = window.document;
globalThis.CONFIG = { JournalEntryPage: {} };

const settings = {
  provider: "openai", openaiApiKey: "test", openaiModel: "m", compatibleBaseUrl: "", anthropicEffort: "",
  sourceLanguage: "English", targetLanguage: "German", glossary: "", instructions: "", maxChars: 6000, concurrency: 2
};
globalThis.game = {
  settings: { get: (_m, k) => settings[k], set: async (_m, k, v) => { settings[k] = v; } },
  i18n: { localize: (k) => k, format: (k) => k }
};

const DICT = { "Area": "Bereich", "The": "Der", "Cellar": "Keller", "Tower": "Turm", "Chapter": "Kapitel", "See": "Siehe", "Rats": "Ratten" };
let requests = 0;
globalThis.fetch = async (_url, init) => {
  requests++;
  const body = JSON.parse(init.body);
  const { segments } = JSON.parse(body.messages[1].content.slice(body.messages[1].content.indexOf("{")));
  // Translate words outside of tags only.
  const translations = segments.map((s) => s.replace(/(^|>)([^<]*)/g, (m, a, text) => a + text.replace(/\b[A-Z][a-z]+\b/g, (w) => DICT[w] ?? w)));
  return { ok: true, json: async () => ({ choices: [{ message: { content: JSON.stringify({ translations }) }, finish_reason: "stop" }], usage: { prompt_tokens: 1, completion_tokens: 1 } }) };
};

const setPath = (obj, path, value) => {
  const keys = path.split(".");
  let o = obj;
  for (const k of keys.slice(0, -1)) o = o[k] ??= {};
  o[keys.at(-1)] = value;
};
const applyUpdate = (doc, u) => { for (const [k, v] of Object.entries(u)) if (k !== "_id") setPath(doc, k, v); };

class FakeDoc {
  flags = {};
  getFlag(m, k) { return this.flags[m]?.[k]; }
  async setFlag(m, k, v) { setPath(this.flags, `${m}.${k}`, structuredClone(v)); }
  async unsetFlag(m, k) { delete this.flags[m]?.[k]; }
  async update(u) { applyUpdate(this, u); }
}
class FakePage extends FakeDoc {
  constructor(entry, data) { super(); this.entry = entry; Object.assign(this, data); }
  get uuid() { return `JournalEntry.${this.entry.id}.JournalEntryPage.${this.id}`; }
}
class FakeEntry extends FakeDoc {
  constructor(id, name, pages) {
    super();
    this.id = id; this.name = name;
    const list = pages.map((p) => new FakePage(this, p));
    this.pages = { contents: list, [Symbol.iterator]: () => list[Symbol.iterator]() };
  }
  get uuid() { return `JournalEntry.${this.id}`; }
  async updateEmbeddedDocuments(_t, updates) {
    for (const u of updates) applyUpdate(this.pages.contents.find((p) => p.id === u._id), u);
  }
}

const { translateEntries, restoreEntry, restoreTranslation } = await import("../scripts/journal.js");

const E1 = "E111111111111111", E2 = "E222222222222222", P1 = "P111111111111111", P2 = "P222222222222222";
const ORIGINAL_P1 = `<h2>Area 4: The Cellar</h2><p>Rats live here. <img src="art/cellar.webp"></p>`;
const ORIGINAL_P2 = `<p>See @UUID[JournalEntry.${E1}.JournalEntryPage.${P1}#area-4-the-cellar]{The Cellar} and [[/r 1d6]] Rats.</p>`;

test("translate in place, fix anchors, then restore", async () => {
  const e1 = new FakeEntry(E1, "Chapter 1", [{ id: P1, name: "The Tower", type: "text", sort: 0, text: { content: ORIGINAL_P1 } }]);
  const e2 = new FakeEntry(E2, "Chapter 2", [{ id: P2, name: "The Cellar", type: "text", sort: 0, text: { content: ORIGINAL_P2 } }]);

  const res = await translateEntries([e1, e2], { mode: "inplace" });
  assert.equal(res.failed, 0);

  const p1 = e1.pages.contents[0], p2 = e2.pages.contents[0];
  assert.equal(e1.name, "Kapitel 1");
  assert.equal(p1.name, "Der Turm");
  assert.equal(p1.text.content, `<h2>Bereich 4: Der Keller</h2><p>Ratten live here. <img src="art/cellar.webp"></p>`);
  assert.equal(p2.text.content,
    `<p>Siehe @UUID[JournalEntry.${E1}.JournalEntryPage.${P1}#bereich-4-der-keller]{Der Keller} and [[/r 1d6]] Ratten.</p>`);
  assert.equal(p1.getFlag("journal-translator", "translated"), true);

  // A second run skips everything that is done.
  const before = requests;
  const again = await translateEntries([e1, e2], { mode: "inplace" });
  assert.equal(again.total, 0);
  assert.equal(requests, before);

  // Restore brings back the exact original.
  await restoreEntry(e1);
  await restoreEntry(e2);
  assert.equal(e1.name, "Chapter 1");
  assert.equal(p1.text.content, ORIGINAL_P1);
  assert.equal(p2.text.content, ORIGINAL_P2);
  assert.equal(p2.name, "The Cellar");
  assert.equal(p1.getFlag("journal-translator", "translated"), false);

  // The translation was kept and comes back without any API request.
  const translatedP1 = `<h2>Bereich 4: Der Keller</h2><p>Ratten live here. <img src="art/cellar.webp"></p>`;
  const beforeToggle = requests;
  for (let i = 0; i < 2; i++) {
    await restoreTranslation(e1);
    await restoreTranslation(e2);
    assert.equal(e1.name, "Kapitel 1");
    assert.equal(p1.name, "Der Turm");
    assert.equal(p1.text.content, translatedP1);
    assert.match(p2.text.content, /#bereich-4-der-keller\]\{Der Keller\}/);
    assert.equal(p1.getFlag("journal-translator", "translated"), true);
    assert.deepEqual(p1.getFlag("journal-translator", "anchors"), [["area-4-the-cellar", "bereich-4-der-keller"]]);

    await restoreEntry(e1);
    await restoreEntry(e2);
    assert.equal(p1.text.content, ORIGINAL_P1);
    assert.equal(p2.text.content, ORIGINAL_P2);
  }
  assert.equal(requests, beforeToggle);
  assert.equal(await restoreEntry(e1), false, "nothing to restore while showing the original");

  // Bringing the translation back clears the stored copy.
  await restoreTranslation(e1);
  await restoreTranslation(e2);
  assert.equal(e1.getFlag("journal-translator", "translation"), undefined);
});

test("backups from v0.1 (without status fields) still restore", async () => {
  const e = new FakeEntry("E444444444444444", "Kapitel", [{ id: "P444444444444444", name: "Turm", type: "text", sort: 0, text: { content: "<p>Deutsch</p>" } }]);
  e.flags["journal-translator"] = { original: { name: "Chapter", pages: { P444444444444444: { name: "Tower", content: "<p>English</p>", caption: null } } } };
  await restoreEntry(e);
  assert.equal(e.pages.contents[0].text.content, "<p>English</p>");
  await restoreTranslation(e);
  assert.equal(e.pages.contents[0].text.content, "<p>Deutsch</p>");
  assert.equal(e.name, "Kapitel");
});

test("countEntries counts tokens without generating", async () => {
  const { countEntries } = await import("../scripts/journal.js");
  const e = new FakeEntry("E333333333333333", "Chapter 3", [{ id: "P333333333333333", name: "The Tower", type: "text", sort: 0, text: { content: ORIGINAL_P1 } }]);
  const before = requests;
  const c = await countEntries([e]);
  assert.equal(requests, before, "no generation request");
  assert.equal(c.method, "tokenizer");
  assert.equal(c.segments, 4); // entry name, page name, heading, paragraph
  assert.ok(c.inputTokens > c.systemTokens);
});
