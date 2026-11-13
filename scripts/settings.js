import { PROVIDERS, PRICES } from "./providers/index.js";

export const MODULE_ID = "journal-translator";

export const DEFAULT_GLOSSARY = `Dungeon Master = Spielleitung
Armor Class (AC) = Rüstungsklasse (RK)
Difficulty Class (DC) = Schwierigkeitsgrad (SG)
Hit Points = Trefferpunkte
Hit Dice = Trefferwürfel
saving throw = Rettungswurf
ability check = Attributswurf
attack roll = Angriffswurf
advantage = Vorteil
disadvantage = Nachteil
short rest = kurze Rast
long rest = lange Rast
Strength = Stärke
Dexterity = Geschicklichkeit
Constitution = Konstitution
Intelligence = Intelligenz
Wisdom = Weisheit
Charisma = Charisma
Acrobatics = Akrobatik
Animal Handling = Mit Tieren umgehen
Arcana = Arkane Kunde
Athletics = Athletik
Deception = Täuschen
History = Geschichte
Insight = Motiv erkennen
Intimidation = Einschüchtern
Investigation = Nachforschungen
Medicine = Heilkunde
Nature = Naturkunde
Perception = Wahrnehmung
Performance = Auftreten
Persuasion = Überzeugen
Religion = Religion
Sleight of Hand = Fingerfertigkeit
Stealth = Heimlichkeit
Survival = Überlebenskunst
Blinded = Blind
Charmed = Bezaubert
Deafened = Taub
Exhaustion = Erschöpfung
Frightened = Verängstigt
Grappled = Gepackt
Incapacitated = Kampfunfähig
Invisible = Unsichtbar
Paralyzed = Gelähmt
Petrified = Versteinert
Poisoned = Vergiftet
Prone = Liegend
Restrained = Festgesetzt
Stunned = Betäubt
Unconscious = Bewusstlos
Challenge Rating = Herausforderungsgrad
experience points (XP) = Erfahrungspunkte (EP)
gold pieces (gp) = Goldmünzen (GM)
silver pieces (sp) = Silbermünzen (SM)
copper pieces (cp) = Kupfermünzen (KM)
feet = Fuß`;

export const DEFAULT_INSTRUCTIONS =
  "Sprich die Spielenden in Vorlesetexten mit „ihr“ an. Verwende die Rechtschreibung nach aktueller deutscher Norm.";

const KEY_SETTINGS = ["openaiApiKey", "anthropicApiKey", "geminiApiKey", "compatibleApiKey"];

export function registerSettings() {
  const s = (key, data) => game.settings.register(MODULE_ID, key, data);
  const L = (k) => `JOURNAL_TRANSLATOR.Settings.${k}`;

  s("provider", {
    name: L("Provider.Name"), hint: L("Provider.Hint"),
    scope: "client", config: true, type: String, default: "openai",
    choices: Object.fromEntries(Object.entries(PROVIDERS).map(([k, v]) => [k, v.label]))
  });

  for (const [id, p] of Object.entries(PROVIDERS)) {
    s(`${id}ApiKey`, {
      name: game.i18n.format("JOURNAL_TRANSLATOR.Settings.ApiKey.Name", { provider: p.label }),
      hint: L("ApiKey.Hint"),
      scope: "client", config: true, type: String, default: ""
    });
    s(`${id}Model`, {
      name: game.i18n.format("JOURNAL_TRANSLATOR.Settings.Model.Name", { provider: p.label }),
      hint: L("Model.Hint"),
      scope: "client", config: true, type: String, default: p.defaultModel
    });
  }

  s("compatibleBaseUrl", {
    name: L("BaseUrl.Name"), hint: L("BaseUrl.Hint"),
    scope: "client", config: true, type: String, default: "https://openrouter.ai/api/v1"
  });

  s("anthropicEffort", {
    name: L("Effort.Name"), hint: L("Effort.Hint"),
    scope: "client", config: true, type: String, default: "low",
    choices: { "": "Standard", low: "low", medium: "medium", high: "high" }
  });

  s("priceInput", {
    name: L("PriceInput.Name"), hint: L("PriceInput.Hint"),
    scope: "client", config: true, type: Number, default: 0
  });
  s("priceOutput", {
    name: L("PriceOutput.Name"), hint: L("PriceInput.Hint"),
    scope: "client", config: true, type: Number, default: 0
  });

  s("sourceLanguage", {
    name: L("SourceLanguage.Name"), scope: "world", config: true, type: String, default: "English"
  });
  s("targetLanguage", {
    name: L("TargetLanguage.Name"), hint: L("TargetLanguage.Hint"),
    scope: "world", config: true, type: String, default: "German"
  });

  s("maxChars", {
    name: L("MaxChars.Name"), hint: L("MaxChars.Hint"),
    scope: "client", config: true, type: Number, default: 12000,
    range: { min: 2000, max: 30000, step: 1000 }
  });
  s("concurrency", {
    name: L("Concurrency.Name"), hint: L("Concurrency.Hint"),
    scope: "client", config: true, type: Number, default: 3,
    range: { min: 1, max: 8, step: 1 }
  });

  // Edited in the translation dialog.
  s("keepLabelTypes", {
    name: L("KeepLabels.Name"), hint: L("KeepLabels.Hint"),
    scope: "world", config: true, type: String, default: "Actor, Scene"
  });

  s("glossary", { scope: "world", config: false, type: String, default: DEFAULT_GLOSSARY });
  s("instructions", { scope: "world", config: false, type: String, default: DEFAULT_INSTRUCTIONS });
}

export const getSetting = (key) => game.settings.get(MODULE_ID, key);
export const setSetting = (key, value) => game.settings.set(MODULE_ID, key, value);

/** Mask API key inputs in the settings dialog. */
export function maskKeyInputs(html) {
  const root = html instanceof HTMLElement ? html : html?.[0];
  if (!root) return;
  for (const key of KEY_SETTINGS) {
    const input = root.querySelector(`input[name="${MODULE_ID}.${key}"]`);
    if (input) {
      input.type = "password";
      input.autocomplete = "off";
    }
  }
}

/** Price per 1M tokens: settings override, else the built-in list, else null. */
export function priceFor(model) {
  const input = Number(getSetting("priceInput")) || 0;
  const output = Number(getSetting("priceOutput")) || 0;
  if (input || output) return { input, output, source: "settings" };
  const known = PRICES[model];
  return known ? { ...known, source: "list" } : null;
}

export function providerConfig() {
  const id = getSetting("provider");
  const p = PROVIDERS[id] ?? PROVIDERS.openai;
  const model = getSetting(`${id}Model`) || p.defaultModel;
  return {
    price: priceFor(model),
    id,
    label: p.label,
    model,
    apiKey: getSetting(`${id}ApiKey`),
    baseUrl: getSetting("compatibleBaseUrl"),
    effort: getSetting("anthropicEffort") || undefined
  };
}

export function createProvider() {
  const cfg = providerConfig();
  return PROVIDERS[cfg.id].create(cfg);
}
