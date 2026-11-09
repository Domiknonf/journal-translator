# Journal Translator (Foundry VTT)

Übersetzt Journale in Foundry VTT (v13/v14) mit einer KI deiner Wahl, zum Beispiel ein komplettes Abenteuer wie *Phandelver and Below: The Shattered Obelisk* ins Deutsche. **Querverweise, Bilder, Actor-Links, Würfelwürfe, Vorlesetexte, Geheimnis-Blöcke und Tabellen bleiben dabei erhalten.**

*English summary: translates Foundry VTT journals with OpenAI, Claude, Gemini or any OpenAI-compatible API while preserving links, images, enrichers and formatting. Originals are backed up and can be restored.*

## Funktionen

- **Anbieter:** OpenAI, Anthropic (Claude), Google Gemini, oder jede OpenAI-kompatible API (OpenRouter, Mistral, Ollama, LM Studio …). Dein eigener API-Key, Anfragen gehen direkt aus deinem Browser zum Anbieter.
- **Nichts geht kaputt:** Bevor ein Text an die KI geht, werden alle Attribute (Bildpfade, UUIDs, CSS-Klassen) und alle Enricher (`@UUID[…]{…}`, `@Embed`, `&Reference`, `[[/r …]]`, `[[/check …]]` …) durch nummerierte Platzhalter ersetzt. Die KI sieht nur die Link-*Beschriftung* und übersetzt diese. Nach der Antwort wird geprüft, ob jeder Platzhalter genau einmal zurückkam; sonst wird der Abschnitt erneut übersetzt oder im Original belassen.
- **Anker-Links werden repariert:** Verweise wie `@UUID[…JournalEntryPage.x#area-4-the-cellar]` zeigen auf Überschriften. Werden die Überschriften übersetzt, werden die Anker automatisch angepasst (`#bereich-4-der-keller`).
- **Original und Übersetzung bleiben erhalten:** Beim direkten Übersetzen wird der Originaltext im Journal selbst gespeichert (als Flag `journal-translator.original`). „Original wiederherstellen“ (Rechtsklick oder Dialog) holt ihn exakt zurück und legt dabei die Übersetzung beiseite; „Übersetzung wiederherstellen“ wechselt ohne neue Kosten wieder zurück. So kannst du beliebig oft zwischen Englisch und Deutsch umschalten.
- **Fortsetzbar:** Jede Seite wird gespeichert, sobald sie fertig ist. Abbrechen und später neu starten setzt dort fort.
- **Glossar:** Ein deutsches D&D-Grundglossar (Rettungswurf, Rüstungsklasse, Zustände, Fertigkeiten …) ist vorbelegt und im Dialog editierbar. Eigene Begriffe (z. B. Ortsnamen) einfach ergänzen.
- **Kosten vorab berechnen:** Die Eingabe-Token werden vor dem Start mit dem Tokenizer des Anbieters gezählt, ohne etwas zu generieren (Claude und Gemini über deren kostenlose Zähl-API, OpenAI mit dem o200k-Tokenizer direkt im Browser). Die Ausgabe wird hochgerechnet, dazu kommt eine Kostenspanne in USD. Nach dem Lauf werden die tatsächlichen Kosten angezeigt.

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

Klicke im Dialog auf **Kosten berechnen**:

- **Eingabe-Token** werden exakt gezählt (Prompt + Glossar + alle Textabschnitte, so wie sie gesendet würden).
- **Ausgabe-Token** lassen sich vorab nicht zählen; sie werden mit Faktor 1,2–1,6 hochgerechnet (Deutsch ist länger als Englisch).
- **Kosten** = Token × Preis. Für gängige Modelle ist eine Preisliste eingebaut; in den Einstellungen kannst du eigene Preise eintragen (USD pro 1 Mio. Token).
- Modelle mit Denkmodus erzeugen zusätzliche, als Ausgabe berechnete Denk-Token. Das Modul hält diese niedrig (OpenAI `reasoning_effort: low`, Gemini Flash ohne Denken, Claude Effort `low`). Für eine verlässliche Zahl: erst ein Kapitel übersetzen, die tatsächlichen Kosten werden danach angezeigt.

Tipps:
- *Zeichen pro Anfrage* (Standard 12 000) höher stellen spart Kosten, da der Prompt (~800 Token mit Glossar) seltener wiederholt wird.
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
