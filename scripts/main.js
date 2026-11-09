import { MODULE_ID, registerSettings, maskKeyInputs } from "./settings.js";
import { TranslatorApp, restoreWithConfirm, restoreTranslationOf } from "./app.js";
import { hasBackup, hasTranslation } from "./journal.js";

let app = null;

export function openTranslator(options = {}) {
  if (!game.user.isGM) return ui.notifications.warn(game.i18n.localize("JOURNAL_TRANSLATOR.Notify.GMOnly"));
  app?.close();
  app = new TranslatorApp(options);
  app.render(true);
  return app;
}

Hooks.once("init", () => {
  registerSettings();
});

Hooks.once("ready", () => {
  const mod = game.modules.get(MODULE_ID);
  if (mod) mod.api = { open: openTranslator };
});

Hooks.on("renderSettingsConfig", (_app, html) => maskKeyInputs(html));

/** Button in the journal sidebar header. */
Hooks.on("renderJournalDirectory", (_app, html) => {
  if (!game.user.isGM) return;
  const root = html instanceof HTMLElement ? html : html?.[0];
  if (!root || root.querySelector(".journal-translator-open")) return;
  const btn = document.createElement("button");
  btn.type = "button";
  btn.className = "journal-translator-open";
  btn.innerHTML = `<i class="fa-solid fa-language"></i> ${game.i18n.localize("JOURNAL_TRANSLATOR.Title")}`;
  btn.addEventListener("click", () => openTranslator());
  const target = root.querySelector(".header-actions") ?? root.querySelector(".directory-header");
  target?.append(btn);
});

const elementOf = (li) => (li instanceof HTMLElement ? li : li?.[0] ?? li);
const entryOf = (li) => game.journal.get(elementOf(li)?.dataset?.entryId ?? elementOf(li)?.dataset?.documentId);
const folderOf = (li) => elementOf(li)?.closest?.("[data-folder-id]")?.dataset.folderId ?? elementOf(li)?.parentElement?.dataset?.folderId;

/** Builds a context menu option compatible with Foundry v13 and v14 property names. */
function option({ name, icon, condition, callback }) {
  return {
    name, label: name, icon,
    condition: (li) => game.user.isGM && condition(li),
    visible: (li) => game.user.isGM && condition(li),
    callback: (li) => callback(li),
    onClick: (_event, li) => callback(li)
  };
}

function addEntryOptions(options) {
  options.push(
    option({
      name: "JOURNAL_TRANSLATOR.ContextTranslate",
      icon: '<i class="fa-solid fa-language"></i>',
      condition: (li) => !!entryOf(li),
      callback: (li) => openTranslator({ entryIds: [entryOf(li).id] })
    }),
    option({
      name: "JOURNAL_TRANSLATOR.Restore",
      icon: '<i class="fa-solid fa-clock-rotate-left"></i>',
      condition: (li) => { const e = entryOf(li); return !!e && hasBackup(e); },
      callback: (li) => restoreWithConfirm(entryOf(li))
    }),
    option({
      name: "JOURNAL_TRANSLATOR.RestoreTranslation",
      icon: '<i class="fa-solid fa-language"></i>',
      condition: (li) => { const e = entryOf(li); return !!e && hasTranslation(e); },
      callback: (li) => restoreTranslationOf(entryOf(li))
    })
  );
}

function addFolderOptions(options) {
  options.push(option({
    name: "JOURNAL_TRANSLATOR.ContextTranslateFolder",
    icon: '<i class="fa-solid fa-language"></i>',
    condition: (li) => !!folderOf(li),
    callback: (li) => openTranslator({ folderId: folderOf(li) })
  }));
}

// v13+ hook names, plus the older names for good measure.
Hooks.on("getJournalEntryContextOptions", (_app, options) => addEntryOptions(options));
Hooks.on("getJournalDirectoryEntryContext", (_app, options) => addEntryOptions(options));
Hooks.on("getJournalDirectoryFolderContext", (_app, options) => addFolderOptions(options));
Hooks.on("getFolderContextOptions", (app, options) => {
  if (app?.documentName === "JournalEntry" || app?.constructor?.documentName === "JournalEntry") addFolderOptions(options);
});
