# Journal Translator (Foundry VTT)

Übersetzt Journale in Foundry VTT (v13/v14) mit einer KI deiner Wahl, zum Beispiel ein komplettes Abenteuer wie *Phandelver and Below: The Shattered Obelisk* ins Deutsche. **Querverweise, Bilder, Actor-Links, Würfelwürfe, Vorlesetexte, Geheimnis-Blöcke und Tabellen bleiben dabei erhalten.**

*English summary: translates Foundry VTT journals with OpenAI, Claude, Gemini or any OpenAI-compatible API while preserving links, images, enrichers and formatting. Originals are backed up and can be restored.*

## Funktionen

- **Anbieter:** OpenAI, Anthropic (Claude), Google Gemini, oder jede OpenAI-kompatible API (OpenRouter, Mistral, Ollama, LM Studio …). Dein eigener API-Key, Anfragen gehen direkt aus deinem Browser zum Anbieter.
- **Nichts geht kaputt:** Bevor ein Text an die KI geht, werden alle Attribute (Bildpfade, UUIDs, CSS-Klassen) und alle Enricher (`@UUID[…]{…}`, `@Embed`, `&Reference`, `[[/r …]]`, `[[/check …]]` …) durch nummerierte Platzhalter ersetzt. Die KI sieht nur die Link-*Beschriftung* und übersetzt diese. Nach der Antwort wird geprüft, ob jeder Platzhalter genau einmal zurückkam; sonst wird der Abschnitt erneut übersetzt oder im Original belassen.
- **Anker-Links werden repariert:** Verweise wie `@UUID[…JournalEntryPage.x#area-4-the-cellar]` zeigen auf Überschriften. Werden die Überschriften übersetzt, werden die Anker automatisch angepasst (`#bereich-4-der-keller`).
- **Original wird gesichert:** Beim direkten Übersetzen wird der Originaltext im Journal gespeichert. „Original wiederherstellen“ (Kontextmenü oder Dialog) holt ihn exakt zurück.
- **Fortsetzbar:** Jede Seite wird gespeichert, sobald sie fertig ist. Abbrechen und später neu starten setzt dort fort.
- **Glossar:** Ein deutsches D&D-Grundglossar (Rettungswurf, Rüstungsklasse, Zustände, Fertigkeiten …) ist vorbelegt und im Dialog editierbar. Eigene Begriffe (z. B. Ortsnamen) einfach ergänzen.
- **Kostenschätzung** vor dem Start, Token-Verbrauch während des Laufs.

## Installation

In Foundry unter *Add-on Modules → Install Module* diese Manifest-URL eintragen:

```
https://github.com/Domiknonf/journal-translator/releases/latest/download/module.json
```

## Benutzung

1. Modul in der Welt aktivieren.
2. *Einstellungen → Moduleinstellungen → Journal Translator*: Anbieter wählen, API-Key und ggf. Modell eintragen.
3. Abenteuer wie gewohnt importieren (die Journale müssen in der Welt liegen, nicht nur im Kompendium).
4. In der Journal-Seitenleiste auf **Journal-Übersetzer** klicken (oder Rechtsklick auf ein Journal/einen Ordner → *Übersetzen …*).
5. Journale auswählen, **Kosten schätzen**, dann **Übersetzen**.

### Modus

| Modus | Wann |
|---|---|
| **Direkt übersetzen** (Standard) | Das Journal selbst wird übersetzt. Alle Karten-Pins, Links aus Actors und Szenen funktionieren weiter. Original kann wiederhergestellt werden. |
| **Übersetzte Kopie** | Kopie in einem neuen Ordner. Links zwischen den kopierten Journalen werden auf die Kopien umgebogen; Karten-Pins zeigen weiterhin auf die Originale. |

## Kosten

Ein großes Abenteuer (~250 Seiten) sind grob 0,5–1 Mio. Eingabe- und ähnlich viele Ausgabe-Token. Rechne mit den aktuellen Preisen deines Modells (meist pro 1 Mio. Token angegeben). Mit einem kleinen, günstigen Modell kostet das ganze Abenteuer typischerweise wenige Euro, mit einem Spitzenmodell eher zweistellig. Die Schätzung im Dialog zeigt die erwarteten Token.

Tipps:
- *Zeichen pro Anfrage* höher stellen spart Kosten (der Prompt wird seltener wiederholt).
- Erst ein einzelnes Kapitel übersetzen und die Qualität prüfen.
- Claude: *Effort* auf `low` (Standard) reicht für Übersetzungen.

## Hinweise

- **Urheberrecht:** Das Modul enthält keine Abenteuerinhalte. Übersetze nur Inhalte, die du besitzt, und teile die Übersetzungen nicht öffentlich.
- **API-Key:** Wird als Client-Einstellung nur in deinem Browser gespeichert. Nur die Spielleitung kann übersetzen.
- **DeepL** wird nicht unterstützt, da die DeepL-API keine direkten Browser-Anfragen erlaubt.
- Verweise aus *nicht* übersetzten Dokumenten (z. B. Actor-Biografien) auf Überschriften-Anker in übersetzten Seiten werden nicht angepasst. Links auf Seiten und Actors funktionieren immer.
- Kompendium-Journale bitte zuerst in die Welt importieren.

## Entwicklung

```bash
npm install
npm test
```

Die Kernlogik (`scripts/core/`) ist unabhängig von Foundry und wird mit jsdom getestet. Ein Release auf GitHub baut über die Action automatisch `module.zip` und `module.json`.

## Lizenz

MIT
