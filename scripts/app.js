import { MODULE_ID, getSetting, setSetting, providerConfig, DEFAULT_GLOSSARY, DEFAULT_INSTRUCTIONS } from "./settings.js";
import { translateEntries, countEntries, restoreEntry, restoreTranslation, hasBackup, hasTranslation } from "./journal.js";
import { priceOf } from "./core/translator.js";

const { ApplicationV2, HandlebarsApplicationMixin } = foundry.applications.api;
const t = (k, data) => (data ? game.i18n.format(`JOURNAL_TRANSLATOR.${k}`, data) : game.i18n.localize(`JOURNAL_TRANSLATOR.${k}`));

export class TranslatorApp extends HandlebarsApplicationMixin(ApplicationV2) {
  static DEFAULT_OPTIONS = {
    id: "journal-translator",
    classes: ["journal-translator"],
    tag: "div",
    window: { title: "JOURNAL_TRANSLATOR.Title", icon: "fa-solid fa-language", resizable: true },
    position: { width: 640, height: 760 },
    actions: {
      estimate: TranslatorApp.#onEstimate,
      start: TranslatorApp.#onStart,
      cancel: TranslatorApp.#onCancel,
      restore: TranslatorApp.#onRestore,
      restoreTranslation: TranslatorApp.#onRestoreTranslation,
      selectAll: TranslatorApp.#onSelectAll,
      selectNone: TranslatorApp.#onSelectNone,
      resetGlossary: TranslatorApp.#onResetGlossary,
      openSettings: TranslatorApp.#onOpenSettings
    }
  };

  static PARTS = {
    main: { template: `modules/${MODULE_ID}/templates/translator.hbs`, scrollable: [".jt-tree"] }
  };

  constructor({ entryIds = [], folderId = null, ...options } = {}) {
    super(options);
    this.selected = new Set(entryIds);
    if (folderId) for (const e of TranslatorApp.entriesInFolder(folderId)) this.selected.add(e.id);
    this.mode = "inplace";
    this.force = false;
    this.running = null;
    this.status = "";
  }

  static entriesInFolder(folderId) {
    const folder = game.folders.get(folderId);
    if (!folder) return [];
    const result = [...folder.contents];
    for (const sub of folder.getSubfolders(true)) result.push(...sub.contents);
    return result;
  }

  get selectedEntries() {
    return [...this.selected].map((id) => game.journal.get(id)).filter(Boolean);
  }

  async _prepareContext() {
    const rows = [];
    const entryRow = (e, depth) => {
      const pages = e.pages.contents;
      const done = pages.filter((p) => p.getFlag(MODULE_ID, "translated")).length;
      rows.push({
        type: "entry", id: e.id, name: e.name, depth, checked: this.selected.has(e.id),
        progress: `${done}/${pages.length}`, complete: pages.length > 0 && done === pages.length, backup: hasBackup(e), translation: hasTranslation(e)
      });
    };
    const folderRow = (f, depth) => {
      rows.push({ type: "folder", id: f.id, name: f.name, depth });
      for (const sub of f.children?.map((c) => c.folder) ?? []) folderRow(sub, depth + 1);
      for (const e of f.contents.slice().sort((a, b) => a.sort - b.sort)) entryRow(e, depth + 1);
    };
    const roots = game.folders.filter((f) => f.type === "JournalEntry" && !f.folder).sort((a, b) => a.sort - b.sort);
    for (const f of roots) folderRow(f, 0);
    for (const e of game.journal.filter((e) => !e.folder).sort((a, b) => a.sort - b.sort)) entryRow(e, 0);

    const cfg = providerConfig();
    return {
      rows,
      provider: cfg.label,
      model: cfg.model,
      hasKey: !!cfg.apiKey || cfg.id === "compatible",
      source: getSetting("sourceLanguage"),
      target: getSetting("targetLanguage"),
      glossary: getSetting("glossary"),
      instructions: getSetting("instructions"),
      mode: this.mode,
      force: this.force,
      running: !!this.running,
      selectedCount: this.selected.size,
      status: this.status
    };
  }

  _onRender(context, options) {
    super._onRender?.(context, options);
    const el = this.element;
    el.querySelectorAll("input[data-entry]").forEach((cb) =>
      cb.addEventListener("change", () => {
        if (cb.checked) this.selected.add(cb.dataset.entry);
        else this.selected.delete(cb.dataset.entry);
        this.#updateCount();
      })
    );
    el.querySelectorAll("input[data-folder]").forEach((cb) =>
      cb.addEventListener("change", () => {
        for (const e of TranslatorApp.entriesInFolder(cb.dataset.folder)) {
          if (cb.checked) this.selected.add(e.id);
          else this.selected.delete(e.id);
          const box = el.querySelector(`input[data-entry="${e.id}"]`);
          if (box) box.checked = cb.checked;
        }
        this.#updateCount();
      })
    );
    el.querySelectorAll("input[name=mode]").forEach((r) => r.addEventListener("change", () => { this.mode = r.value; }));
    el.querySelector("input[name=force]")?.addEventListener("change", (ev) => { this.force = ev.currentTarget.checked; });
  }

  #updateCount() {
    const c = this.element.querySelector(".jt-count");
    if (c) c.textContent = t("Selected", { count: this.selected.size });
  }

  #setStatus(html) {
    this.status = html;
    const s = this.element?.querySelector(".jt-status");
    if (s) s.innerHTML = html;
  }

  async #saveTexts() {
    const g = this.element.querySelector("textarea[name=glossary]");
    const i = this.element.querySelector("textarea[name=instructions]");
    if (g && g.value !== getSetting("glossary")) await setSetting("glossary", g.value);
    if (i && i.value !== getSetting("instructions")) await setSetting("instructions", i.value);
  }

  #requireSelection() {
    if (this.selected.size) return true;
    ui.notifications.warn(t("Notify.NoSelection"));
    return false;
  }

  static async #onEstimate() {
    if (this.running || !this.#requireSelection()) return;
    await this.#saveTexts();
    const cfg = providerConfig();
    const fmt = (n) => Math.round(n).toLocaleString(game.i18n.lang);
    const usd = (n) => (n < 0.01 ? "< $0.01" : `$${n.toFixed(2)}`);
    this.#setStatus(`<i class="fa-solid fa-spinner fa-spin"></i> ${t("Counting")}`);
    try {
      const c = await countEntries(this.selectedEntries, { force: this.force });
      const lines = [
        t(c.method === "api" ? "Count.Exact" : "Count.Tokenizer", { model: cfg.model }),
        t("Count.Input", {
          segments: fmt(c.segments), requests: fmt(c.requests), input: fmt(c.inputTokens),
          system: fmt(c.systemTokens)
        }),
        t("Count.Output", { low: fmt(c.outputTokens.low), high: fmt(c.outputTokens.high) })
      ];
      if (cfg.price) {
        const low = priceOf(c.inputTokens, c.outputTokens.low, cfg.price);
        const high = priceOf(c.inputTokens, c.outputTokens.high, cfg.price);
        lines.push(`<strong>${t("Count.Cost", { low: usd(low), high: usd(high) })}</strong>`);
        lines.push(`<span class="hint">${t(cfg.price.source === "settings" ? "Count.PriceSettings" : "Count.PriceList", {
          input: cfg.price.input, output: cfg.price.output })}</span>`);
      } else {
        lines.push(`<span class="hint">${t("Count.NoPrice")}</span>`);
      }
      lines.push(`<span class="hint">${t("Count.Thinking")}</span>`);
      this.#setStatus(lines.join("<br>"));
    } catch (err) {
      console.error(err);
      this.#setStatus(`<span class="jt-error">${foundry.utils.escapeHTML?.(err.message) ?? err.message}</span>`);
    }
  }

  static async #onStart() {
    if (this.running || !this.#requireSelection()) return;
    await this.#saveTexts();
    const entries = this.selectedEntries;
    const controller = new AbortController();
    this.running = controller;
    await this.render();
    const started = Date.now();
    const fmt = (n) => n.toLocaleString(game.i18n.lang);
    try {
      const res = await translateEntries(entries, {
        mode: this.mode,
        force: this.force,
        signal: controller.signal,
        onProgress: (p) => {
          const pct = p.total ? Math.floor((p.done / p.total) * 100) : 0;
          this.#setStatus(
            `<progress max="100" value="${pct}"></progress> ${pct}% · ` +
            t("Progress", { done: fmt(p.done), total: fmt(p.total), failed: fmt(p.failed),
              input: fmt(p.usage?.input ?? 0), output: fmt(p.usage?.output ?? 0) })
          );
        }
      });
      const minutes = Math.max(1, Math.round((Date.now() - started) / 60000));
      const msg = t("Notify.Done", { done: fmt(res.done), failed: fmt(res.failed), minutes });
      const cost = priceOf(res.usage.input, res.usage.output, providerConfig().price);
      this.#setStatus(`${msg}<br>${t("Usage", { input: fmt(res.usage.input), output: fmt(res.usage.output) })}` +
        (cost !== null ? ` ${t("ActualCost", { cost: `$${cost.toFixed(2)}` })}` : ""));
      if (res.failed) ui.notifications.warn(msg);
      else ui.notifications.info(msg);
      if (this.mode === "copy") this.selected = new Set(res.entries.map((e) => e.id));
    } catch (err) {
      if (err.name === "AbortError") {
        this.#setStatus(t("Notify.Cancelled"));
        ui.notifications.info(t("Notify.Cancelled"));
      } else {
        console.error(err);
        this.#setStatus(`<span class="jt-error">${foundry.utils.escapeHTML?.(err.message) ?? err.message}</span>`);
        ui.notifications.error(t("Notify.Error", { message: err.message }));
      }
    } finally {
      this.running = null;
      await this.render();
    }
  }

  static #onCancel() {
    this.running?.abort();
  }

  static async #onRestore() {
    if (!this.#requireSelection()) return;
    const entries = this.selectedEntries.filter(hasBackup);
    if (!entries.length) return ui.notifications.warn(t("Notify.NoBackup"));
    const ok = await foundry.applications.api.DialogV2.confirm({
      window: { title: t("Restore") },
      content: `<p>${t("RestoreConfirm", { count: entries.length })}</p>`
    });
    if (!ok) return;
    for (const e of entries) await restoreEntry(e);
    ui.notifications.info(t("Notify.Restored", { count: entries.length }));
    this.render();
  }

  static async #onRestoreTranslation() {
    if (!this.#requireSelection()) return;
    const entries = this.selectedEntries.filter(hasTranslation);
    if (!entries.length) return ui.notifications.warn(t("Notify.NoTranslation"));
    for (const e of entries) await restoreTranslation(e);
    ui.notifications.info(t("Notify.TranslationRestored", { count: entries.length }));
    this.render();
  }

  static #onSelectAll() {
    for (const e of game.journal) this.selected.add(e.id);
    this.render();
  }

  static #onSelectNone() {
    this.selected.clear();
    this.render();
  }

  static async #onResetGlossary() {
    await setSetting("glossary", DEFAULT_GLOSSARY);
    await setSetting("instructions", DEFAULT_INSTRUCTIONS);
    this.render();
  }

  static #onOpenSettings() {
    const app = game.settings.sheet;
    app.render(true);
    // Jump to this module's tab when the settings sheet supports it.
    setTimeout(() => app.changeTab?.(MODULE_ID, "categories"), 50);
  }
}

export async function restoreWithConfirm(entry) {
  const ok = await foundry.applications.api.DialogV2.confirm({
    window: { title: t("Restore") },
    content: `<p>${t("RestoreConfirm", { count: 1 })}</p>`
  });
  if (ok && (await restoreEntry(entry))) ui.notifications.info(t("Notify.Restored", { count: 1 }));
}

export async function restoreTranslationOf(entry) {
  if (await restoreTranslation(entry)) ui.notifications.info(t("Notify.TranslationRestored", { count: 1 }));
}
