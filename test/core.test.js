import { test } from "node:test";
import assert from "node:assert/strict";
import { JSDOM } from "jsdom";

import { protectElement, restore, splitEnricher } from "../scripts/core/protect.js";
import { collectSegments, unwrapRuns } from "../scripts/core/segment.js";
import { translateItems, parseTranslations, makeBatches } from "../scripts/core/translator.js";
import { rewriteLinks, defaultSlugify } from "../scripts/core/links.js";
import { anthropic, openAICompatible, gemini } from "../scripts/providers/index.js";

const { document } = new JSDOM("<!doctype html><body></body>").window;

const SAMPLE = `
<h2>Area 3: The Old Watchtower</h2>
<section class="fvtt-readaloud"><p>A crumbling <strong>stone tower</strong> rises above the trees.</p></section>
<p>Two @UUID[Actor.abcdefghijklmnop]{Goblins} guard the door. A character who succeeds on a [[/check skill=prc dc=13]] notices them. See @UUID[JournalEntry.AAAAAAAAAAAAAAAA.JournalEntryPage.BBBBBBBBBBBBBBBB#area-4-the-cellar]{Area 4}.</p>
<p><img src="modules/example/art/tower.webp" alt="Tower" width="400"></p>
<ul><li>Treasure: [[/r 2d6 * 10]] gp
  <ul><li>A <a href="https://example.com" class="x">silver key</a></li></ul>
</li></ul>
<table><tr><th>d6</th><th>Encounter</th></tr><tr><td>1</td><td>@UUID[Compendium.dnd5e.monsters.Actor.zzzzzzzzzzzzzzzz]</td></tr></table>
<section class="secret" id="secret-1"><p>The tower is haunted.</p></section>`;

function fakeTranslate(html) {
  // Simulate a translator: change visible words, keep markup.
  return html
    .replace(/Area 3: The Old Watchtower/, "Bereich 3: Der alte Wachturm")
    .replace(/crumbling/, "bröckelnder")
    .replace(/stone tower/, "Steinturm")
    .replace(/Goblins/, "Goblins")
    .replace(/Area 4/, "Bereich 4")
    .replace(/silver key/, "Silberschlüssel")
    .replace(/The tower is haunted\./, "Im Turm spukt es.");
}

test("splitEnricher separates label", () => {
  assert.deepEqual(splitEnricher("@UUID[Actor.x]{Goblin}"), { core: "@UUID[Actor.x]", label: "Goblin" });
  assert.deepEqual(splitEnricher("[[/r 1d20]]"), { core: "[[/r 1d20]]", label: null });
  assert.deepEqual(splitEnricher("[[/check dex 15]]{Dex check}"), { core: "[[/check dex 15]]", label: "Dex check" });
});

test("protect hides attributes and enrichers, restore brings them back", () => {
  const root = document.createElement("div");
  root.innerHTML = SAMPLE;
  const segs = collectSegments(root);
  for (const el of segs) {
    const { html, state } = protectElement(el);
    assert.ok(!html.includes("modules/example"), "image path hidden");
    assert.ok(!html.includes("abcdefghijklmnop"), "uuid hidden");
    assert.ok(!html.includes("[["), "rolls hidden");
    const r = restore(fakeTranslate(html), state, document);
    assert.ok(r.ok, r.error);
    el.innerHTML = r.html;
  }
  unwrapRuns(root);
  const out = root.innerHTML;
  assert.match(out, /Bereich 3: Der alte Wachturm/);
  assert.match(out, /@UUID\[Actor\.abcdefghijklmnop\]\{Goblins\}/);
  assert.match(out, /\[\[\/check skill=prc dc=13\]\]/);
  assert.match(out, /@UUID\[JournalEntry\.AAAAAAAAAAAAAAAA\.JournalEntryPage\.BBBBBBBBBBBBBBBB#area-4-the-cellar\]\{Bereich 4\}/);
  assert.match(out, /<img src="modules\/example\/art\/tower\.webp" alt="Tower" width="400">/);
  assert.match(out, /\[\[\/r 2d6 \* 10\]\] gp/);
  assert.match(out, /<a href="https:\/\/example\.com" class="x">Silberschlüssel<\/a>/);
  assert.match(out, /@UUID\[Compendium\.dnd5e\.monsters\.Actor\.zzzzzzzzzzzzzzzz\]/);
  assert.match(out, /<section class="secret" id="secret-1"><p>Im Turm spukt es\.<\/p><\/section>/);
  assert.match(out, /<section class="fvtt-readaloud"><p>A bröckelnder <strong>Steinturm<\/strong>/);
  assert.ok(!out.includes("data-jt-run"), "run wrappers removed");
  assert.ok(!out.includes("data-k"), "no placeholders left");
});

test("segments skip number-only cells and keep nested lists separate", () => {
  const root = document.createElement("div");
  root.innerHTML = SAMPLE;
  const texts = collectSegments(root).map((s) => s.textContent.trim());
  assert.ok(!texts.includes("1"));
  assert.ok(texts.some((t) => t.startsWith("Treasure")));
  assert.ok(texts.includes("A silver key"));
});

test("restore rejects lost or duplicated placeholders", () => {
  const p = document.createElement("p");
  p.innerHTML = 'Hit the @UUID[Actor.x]{orc} with <a href="y">this</a>.';
  const { html, state } = protectElement(p);
  assert.equal(restore(html.replace(/<x-e[^>]*>.*?<\/x-e>/, "Ork"), state, document).ok, false);
  assert.equal(restore(html.replace("</a>", '</a><a data-k="0">x</a>'), state, document).ok, false);
  assert.equal(restore(html, state, document).ok, true);
});

test("empty label falls back to original label", () => {
  const p = document.createElement("p");
  p.innerHTML = "See @UUID[Actor.x]{Bob}.";
  const { html, state } = protectElement(p);
  const r = restore(html.replace(">Bob<", "><"), state, document);
  assert.equal(r.html, "See @UUID[Actor.x]{Bob}.");
});

test("parseTranslations handles fences and bare arrays", () => {
  assert.deepEqual(parseTranslations('```json\n{"translations":["a","b"]}\n```'), ["a", "b"]);
  assert.deepEqual(parseTranslations('["x"]'), ["x"]);
  assert.deepEqual(parseTranslations('Sure! {"translations":["y"]}'), ["y"]);
});

test("makeBatches respects context and size", () => {
  const items = [
    { html: "a".repeat(40), context: "A" },
    { html: "b".repeat(40), context: "A" },
    { html: "c".repeat(40), context: "A" },
    { html: "d", context: "B" }
  ];
  const b = makeBatches(items, { maxChars: 90 });
  assert.deepEqual(b.map((x) => x.items.length), [2, 1, 1]);
});

test("translateItems retries broken items individually and keeps failures", async () => {
  const calls = [];
  const provider = {
    async complete({ user }) {
      const json = JSON.parse(user.slice(user.indexOf("{")));
      calls.push(json.segments.length);
      const translations = json.segments.map((s) => (s === "BAD" ? "still bad" : s.toUpperCase()));
      return { text: JSON.stringify({ translations }), usage: { input: 10, output: 5 } };
    }
  };
  const mk = (id, html) => ({ id, html, context: "c", check: (o) => (o === "still bad" ? null : o) });
  const res = await translateItems({
    provider, items: [mk(1, "a"), mk(2, "BAD"), mk(3, "c")], prompt: {}, logger: {}
  });
  assert.equal(res.results.get(1), "A");
  assert.equal(res.results.get(3), "C");
  assert.equal(res.results.get(2), null);
  assert.equal(res.failed, 1);
  assert.deepEqual(calls, [3, 1, 1]);
  assert.equal(res.usage.input, 30);
});

test("translateItems splits a batch when the count does not match", async () => {
  const provider = {
    async complete({ user }) {
      const json = JSON.parse(user.slice(user.indexOf("{")));
      const t = json.segments.map((s) => s + "!");
      if (t.length > 1) t.pop();
      return { text: JSON.stringify({ translations: t }) };
    }
  };
  const items = [1, 2, 3, 4].map((i) => ({ id: i, html: `s${i}`, context: "c", check: (o) => o }));
  const res = await translateItems({ provider, items, prompt: {}, logger: {} });
  assert.deepEqual([...res.results.values()].sort(), ["s1!", "s2!", "s3!", "s4!"]);
});

test("fatal provider errors stop the job", async () => {
  const provider = { async complete() { const e = new Error("HTTP 401"); e.fatal = true; throw e; } };
  const items = [{ id: 1, html: "x", context: "c", check: (o) => o }];
  await assert.rejects(translateItems({ provider, items, prompt: {}, logger: {} }), /401/);
});

test("rewriteLinks updates anchors and redirects copied entries", () => {
  const E = "AAAAAAAAAAAAAAAA", P = "BBBBBBBBBBBBBBBB", N = "NNNNNNNNNNNNNNNN";
  const anchors = new Map([[`${N}.${P}`, new Map([["area-4-the-cellar", "bereich-4-der-keller"]])]]);
  const content =
    `@UUID[JournalEntry.${E}.JournalEntryPage.${P}#area-4-the-cellar]{Bereich 4} ` +
    `@UUID[.${P}#area-4-the-cellar]{hier} @UUID[Compendium.x.y.JournalEntry.${E}]{Komp} ` +
    `@Embed[JournalEntry.${E} inline]`;
  const out = rewriteLinks(content, { entryId: N, entryIdMap: new Map([[E, N]]), anchors });
  assert.equal(out,
    `@UUID[JournalEntry.${N}.JournalEntryPage.${P}#bereich-4-der-keller]{Bereich 4} ` +
    `@UUID[.${P}#bereich-4-der-keller]{hier} @UUID[Compendium.x.y.JournalEntry.${E}]{Komp} ` +
    `@Embed[JournalEntry.${N} inline]`);
});

test("defaultSlugify", () => {
  assert.equal(defaultSlugify("Area 4: The Cellar"), "area-4-the-cellar");
});

const fakeFetch = (payload, capture) => async (url, init) => {
  capture.url = url;
  capture.init = init;
  capture.body = JSON.parse(init.body);
  return { ok: true, json: async () => payload, headers: new Map() };
};

test("anthropic provider builds a valid request", async () => {
  const cap = {};
  const p = anthropic({
    apiKey: "k", model: "claude-opus-5-5", effort: "low",
    fetchImpl: fakeFetch({ stop_reason: "end_turn", content: [{ type: "thinking", thinking: "" }, { type: "text", text: '{"translations":["x"]}' }], usage: { input_tokens: 5, output_tokens: 2 } }, cap)
  });
  const r = await p.complete({ system: "s", user: "u", schema: { type: "object" } });
  assert.equal(r.text, '{"translations":["x"]}');
  assert.equal(cap.url, "https://api.anthropic.com/v1/messages");
  assert.equal(cap.init.headers["anthropic-dangerous-direct-browser-access"], "true");
  assert.equal(cap.body.output_config.format.type, "json_schema");
  assert.equal(cap.body.output_config.effort, "low");
  assert.equal(cap.body.fallbacks, "default");
  assert.ok(!("temperature" in cap.body));
});

test("openai and gemini providers parse responses", async () => {
  const cap = {};
  const o = openAICompatible({
    apiKey: "k", model: "m", baseUrl: "https://api.openai.com/v1/", strictSchema: true,
    fetchImpl: fakeFetch({ choices: [{ message: { content: "{}" }, finish_reason: "stop" }], usage: { prompt_tokens: 1, completion_tokens: 2 } }, cap)
  });
  assert.equal((await o.complete({ system: "s", user: "u", schema: {} })).usage.output, 2);
  assert.equal(cap.url, "https://api.openai.com/v1/chat/completions");
  assert.equal(cap.body.response_format.type, "json_schema");

  const g = gemini({
    apiKey: "k", model: "gemini-x",
    fetchImpl: fakeFetch({ candidates: [{ content: { parts: [{ text: "{}" }] }, finishReason: "STOP" }] }, cap)
  });
  assert.equal((await g.complete({ system: "s", user: "u" })).text, "{}");
  assert.match(cap.url, /models\/gemini-x:generateContent$/);
});
