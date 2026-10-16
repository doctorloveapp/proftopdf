import { test } from "node:test";
import assert from "node:assert/strict";
import { createElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import StudioWorkspace from "../../src/components/StudioWorkspace";

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
