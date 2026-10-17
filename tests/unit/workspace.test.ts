import { test } from "node:test";
import assert from "node:assert/strict";
import { createElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import StudioWorkspace from "../../src/components/StudioWorkspace";
import AudioSelection from "../../src/components/AudioSelection";
import AudioPartsList from "../../src/components/AudioPartsList";

test("Audio selection accepts multiple files and shows accessible ordering/removal controls and the total", () => {
  const html = renderToStaticMarkup(
    createElement(AudioSelection, {
      files: [
        new File(["audio"], "parte1.mp3"),
        new File(["audio"], "parte2.mp3"),
      ],
      disabled: false,
      restoring: false,
      onChoose: () => {},
      onOrder: () => {},
    }),
  );
  assert(html.includes('multiple=""'));
  assert(html.includes("Aggiungi registrazioni"));
  assert(!html.includes("Cambia selezione"));
  assert(html.includes("Sfoglia tutti i file"));
  assert(html.includes("Recordings"));
  assert(!/<details[^>]*\bopen\b/.test(html));
  assert(html.includes("Sposta su lo spezzone 2"));
  assert(html.includes("Rimuovi lo spezzone 1"));
  const saved = renderToStaticMarkup(
    createElement(AudioPartsList, {
      items: [
        { name: "p1", durationSeconds: 100, lastModified: 1000 },
        { name: "p2", durationSeconds: 80, lastModified: 2000 },
      ],
    }),
  );
  assert(saved.includes("3 min 00 s"));
  assert(!saved.includes("part-control"));
});

test("The initial workspace opens on the library then remaining quota, with a new lesson action and no editor", () => {
  const html = renderToStaticMarkup(
    createElement(StudioWorkspace, {
      csrfToken: "synthetic",
      onSessionExpired: () => {},
    }),
  );
  assert(html.includes("Le tue lezioni"));
  assert(html.includes("Nuova lezione"));
  assert(html.indexOf("lessons-panel") < html.indexOf("quota-panel"));
  assert(html.includes("Disponibilità residua"));
  assert(!html.includes("upload-panel"));
  assert(!html.includes("Disponibilità condivisa"));
});
