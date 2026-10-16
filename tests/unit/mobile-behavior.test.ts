import assert from "node:assert/strict";
import { test } from "node:test";
import {
  INSTALL_MARKER,
  observeInstallation,
  type InstallPrompt,
  type InstallState,
} from "../../src/lib/client/install";
import {
  creationDate,
  documentFileStem,
  documentHeading,
} from "../../src/lib/pdf/naming";
import {
  transcriptionProfile,
  transcriptionContext,
  SUBJECTS,
} from "../../src/lib/shared/lecture";
import { buildNotesRequest } from "../../src/lib/notes/request";
import { buildTextUnits } from "../../src/lib/notes/assemble";
import {
  importCheckpoint,
  exportCheckpoint,
} from "../../src/lib/storage/checkpoint";
import { browserAdapter } from "../../src/lib/pipeline/process-lecture";

function installationFixture({ standalone = false, apple = false } = {}) {
  const host = new EventTarget();
  const media = Object.assign(new EventTarget(), { matches: standalone });
  const store = new Map<string, string>();
  let state!: InstallState;
  const manager = observeInstallation(
    Object.assign(host, {
      matchMedia: () => media as unknown as MediaQueryList,
    }),
    {
      userAgent: apple ? "Mozilla iPhone" : "Mozilla Android",
      platform: apple ? "iPhone" : "Linux",
      maxTouchPoints: 5,
    },
    {
      getItem: (key) => store.get(key) ?? null,
      setItem: (key, value) => {
        store.set(key, value);
      },
    },
    (next) => {
      state = next;
    },
  );
  return { host, store, media, manager, state: () => state };
}
test("Android installation opens only on a tap, dismissal is not persisted, acceptance hides controls", async () => {
  const f = installationFixture();
  let prompts = 0;
  const event = Object.assign(
    new Event("beforeinstallprompt", { cancelable: true }),
    {
      prompt: async () => {
        prompts++;
      },
      userChoice: Promise.resolve({ outcome: "dismissed" as const }),
    },
  );
  f.host.dispatchEvent(event);
  assert(event.defaultPrevented);
  assert.equal(prompts, 0);
  assert(f.state().canPrompt);
  assert.equal(await f.manager.install(), "dismissed");
  assert.equal(f.state().installed, false);
  assert.equal(f.store.has(INSTALL_MARKER), false);
  f.host.dispatchEvent(
    Object.assign(new Event("beforeinstallprompt"), {
      prompt: async () => {
        prompts++;
      },
      userChoice: Promise.resolve({ outcome: "accepted" as const }),
    }) as InstallPrompt,
  );
  assert.equal(await f.manager.install(), "accepted");
  assert.equal(prompts, 2);
  assert(f.state().installed);
  assert.equal(f.store.get(INSTALL_MARKER), "true");
  f.manager.dispose();
});
test("Apple instructions can be acknowledged; standalone launch and appinstalled hide installation", async () => {
  const apple = installationFixture({ apple: true });
  assert(apple.state().apple);
  assert.equal(await apple.manager.install(), "instructions");
  apple.manager.remember();
  assert(apple.state().installed);
  apple.manager.dispose();
  const installed = installationFixture({ standalone: true });
  assert(installed.state().installed);
  installed.manager.dispose();
  const android = installationFixture();
  android.host.dispatchEvent(new Event("appinstalled"));
  assert(android.state().installed);
  android.manager.dispose();
});
test("PDF identity keeps Italian date order/Rome timezone, optional subject and a valid Unicode filename", () => {
  const date = "2026-10-16T22:30:00.000Z"; // already 17 October in Rome
  const doc = {
    subject: "Greco",
    title: "ἄνθρωπος / λόγος: introduzione",
    createdAt: date,
  };
  assert.equal(creationDate(date), "17/10/2026");
  assert.equal(documentHeading(doc), "Greco - 17/10/2026");
  const name = documentFileStem(doc);
  assert(name.startsWith("Greco - ἄνθρωπος - λόγος- introduzione"));
  assert(name.endsWith("17-10-2026"));
  assert(!/[\\/:*?"<>|]/.test(name));
  assert.equal(documentHeading({ ...doc, subject: "" }), "17/10/2026");
  assert(!documentFileStem({ ...doc, subject: "" }).startsWith(" -"));
  assert(
    new TextEncoder().encode(
      `${documentFileStem({ ...doc, title: "ἄνθρωπος".repeat(50) })}.pdf`,
    ).length <= 240,
  );
});
test("Mixed-language context and prompts preserve source languages without accepting a client-written STT prompt", () => {
  assert.equal(transcriptionProfile(" inglese "), "english");
  assert.match(transcriptionContext("ancient-greek")!, /greco antico/);
  assert.match(transcriptionContext("latin")!, /lingua latina/);
  assert.equal(transcriptionContext("general"), undefined);
  for (const subject of SUBJECTS) {
    const request = buildNotesRequest({
      jobId: crypto.randomUUID(),
      unitId: "test",
      mode: "notes",
      attempt: 0,
      title: "Lezione",
      subject,
      sources: [
        {
          id: "s0",
          text: "Spiegazione italiana. English stays English. Cogito ergo sum. ἄνθρωπος.",
          uncertain: true,
        },
      ],
    });
    assert.match(request.messages[0].content, /Non tradurre/);
    assert(request.messages[1].content.includes("English stays English"));
    assert(request.messages[1].content.includes("ἄνθρωπος"));
  }
});
test("Language-specific prompts and maximum Unicode metadata stay within the free request budget", () => {
  const units = buildTextUnits([
    {
      id: "s0-0",
      chunkId: "s0",
      startSeconds: 0,
      endSeconds: 120,
      status: "confirmed",
      text: "Italiano, English, cogito, ἄνθρωπος. ".repeat(130),
    },
  ]);
  for (const subject of [...SUBJECTS, "α".repeat(200)]) {
    for (const unit of units) {
      const payload = buildNotesRequest({
        jobId: crypto.randomUUID(),
        unitId: unit.id,
        mode: "notes",
        attempt: 0,
        title: "ω".repeat(200),
        subject,
        sources: unit.sources,
      });
      assert(
        payload.tokenUpperBound <= 6000,
        `${subject}: ${payload.tokenUpperBound}`,
      );
    }
  }
});
test("New automatic-language checkpoints round-trip and old Italian checkpoints remain compatible", () => {
  const old = {
    schema: "proftopdf/checkpoint/v1",
    title: "Lezione",
    subject: "Inglese",
    language: "it",
    source: {
      name: "123.mp3",
      byteLength: 1000,
      durationSeconds: 10,
      sha256: "a".repeat(64),
      mimeType: "audio/mpeg",
    },
    chunks: [],
  };
  assert.equal(importCheckpoint(JSON.stringify(old)).manifest.language, "it");
  const automatic = importCheckpoint(
    JSON.stringify({ ...old, language: "auto" }),
  );
  assert.equal(
    importCheckpoint(exportCheckpoint(automatic)).manifest.language,
    "auto",
  );
});

test("STT requests send a bounded subject profile and pin the legacy mode when recovering an old checkpoint", async (t) => {
  const headers: Headers[] = [];
  t.mock.method(
    globalThis,
    "fetch",
    async (_url: RequestInfo | URL, init?: RequestInit) => {
      headers.push(new Headers(init?.headers));
      return new Response(JSON.stringify({ ok: true, data: {} }), {
        headers: { "Content-Type": "application/json" },
      });
    },
  );
  const local = importCheckpoint(
    JSON.stringify({
      schema: "proftopdf/checkpoint/v1",
      title: "Lezione",
      subject: "Inglese",
      language: "auto",
      source: {
        name: "123.mp3",
        byteLength: 1000,
        durationSeconds: 10,
        sha256: "a".repeat(64),
        mimeType: "audio/mpeg",
      },
      chunks: [],
    }),
  );
  const chunk = {
    id: "x",
    index: 0,
    startSeconds: 0,
    endSeconds: 10,
    overlapSeconds: 0,
    byteLength: 1000,
    sha256: "b".repeat(64),
    mimeType: "audio/mpeg",
    container: "mp3",
    codec: "mp3",
  };
  const adapter = browserAdapter("synthetic-csrf");
  await adapter.transcribe(
    new Blob(["test"]),
    chunk,
    local,
    0,
    false,
    new AbortController().signal,
  );
  local.manifest.language = "it";
  await adapter.transcribe(
    new Blob(["test"]),
    chunk,
    local,
    0,
    false,
    new AbortController().signal,
  );
  assert.equal(headers[0].get("x-lecture-profile"), "english");
  assert.equal(headers[0].get("x-language-mode"), "auto");
  assert.equal(headers[1].get("x-language-mode"), "it");
});
