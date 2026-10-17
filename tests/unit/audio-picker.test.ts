import { test } from "node:test";
import assert from "node:assert/strict";
import {
  createAudioPicker,
  AUDIO_PICKER_ID,
  type AudioPickerOptions,
} from "../../src/lib/client/audio-picker";
import {
  appendAudioFiles,
  validateAudioSelection,
} from "../../src/lib/audio/timeline";

test("Additional selections append sorted new files and retain the previous manually corrected order", () => {
  const file = (name: string, date: number) =>
    new File(["audio"], name, { lastModified: date });
  const first = file("part2.mp3", 2000),
    second = file("part1.mp3", 1000),
    three = file("part3.mp3", 4000),
    four = file("part4.mp3", 3000);
  const prior = [first, second];
  const result = appendAudioFiles(prior, [three, four]);
  assert.deepEqual(result.files, [first, second, four, three]);
  assert.deepEqual(prior, [first, second]);
  assert.equal(result.duplicates, 0);
  assert.deepEqual(appendAudioFiles([], [three, second, first]).files, [
    second,
    first,
    three,
  ]);
});
test("Repeated file selections use a metadata duplicate safeguard and combined limits are enforced atomically", () => {
  const original = new File(["audio"], "part1.mp3", { lastModified: 1234 });
  const again = new File(["audio"], "part1.mp3", { lastModified: 1234 });
  const result = appendAudioFiles([original], [again, again]);
  assert.deepEqual(result.files, [original]);
  assert.equal(result.duplicates, 2);
  const many = Array.from(
    { length: 51 },
    (_, i) => new File(["a"], `${i}.mp3`),
  );
  assert.throws(
    () =>
      validateAudioSelection(
        appendAudioFiles(many.slice(0, 50), many.slice(50)).files,
      ),
    /50/,
  );
  const large = { size: 80_000_000 } as File;
  assert.throws(() => validateAudioSelection([large, large]), /120 MB/);
});
test("Audio picker reuses the stable directory ID and selected file handle for filtered and unfiltered additions", async () => {
  const options: AudioPickerOptions[] = [];
  const files = [new File(["a"], "a.mp3"), new File(["b"], "b.m4a")];
  const handles = files.map((file) => ({ getFile: async () => file }));
  const picker = createAudioPicker(() => async (value) => {
    options.push(value);
    return [handles[options.length - 1]];
  });
  assert.equal(picker.canRememberLocation(), true);
  assert.deepEqual(await picker.open(), [files[0]]);
  assert.deepEqual(await picker.open(true), [files[1]]);
  assert.equal(options[0].id, AUDIO_PICKER_ID);
  assert.equal(options[1].id, AUDIO_PICKER_ID);
  assert.equal(options[0].startIn, undefined);
  assert.equal(options[1].startIn, handles[0]);
  assert(options[0].types);
  assert.equal(options[1].types, undefined);
  assert.equal(options[1].multiple, true);
});
test("Cancelled audio dialogs keep the remembered handle; an unavailable browser uses the normal input", async () => {
  const handle = { getFile: async () => new File(["a"], "a.mp3") };
  let calls = 0;
  const picker = createAudioPicker(() => async (options) => {
    calls++;
    if (calls === 2) throw new DOMException("Cancel", "AbortError");
    if (calls === 3) assert.equal(options.startIn, handle);
    return [handle];
  });
  await picker.open();
  assert.deepEqual(await picker.open(), []);
  await picker.open();
  const unavailable = createAudioPicker(() => undefined);
  assert.equal(unavailable.canRememberLocation(), false);
  assert.equal(await unavailable.open(), null);
});
test("A missing remembered location is cleared safely and permission errors do not silently reopen dialogs", async () => {
  let calls = 0;
  const handle = { getFile: async () => new File(["a"], "a.mp3") };
  const picker = createAudioPicker(() => async (options) => {
    calls++;
    if (calls === 2)
      throw new DOMException("Location unavailable", "NotFoundError");
    if (calls === 3) {
      assert.equal(options.startIn, undefined);
      throw new DOMException("Denied", "NotAllowedError");
    }
    return [handle];
  });
  await picker.open();
  await assert.rejects(() => picker.open(), { name: "NotFoundError" });
  await assert.rejects(() => picker.open(), { name: "NotAllowedError" });
  assert.equal(calls, 3);
});
