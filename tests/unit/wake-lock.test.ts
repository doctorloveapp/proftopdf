import { test } from "node:test";
import assert from "node:assert/strict";
import {
  createWakeLock,
  type WakeStatus,
  type ScreenLock,
} from "../../src/lib/client/wake-lock";
class Lock extends EventTarget implements ScreenLock {
  released = false;
  async release() {
    this.released = true;
    this.dispatchEvent(new Event("release"));
  }
}
const tick = () => new Promise((resolve) => setTimeout(resolve, 0));
function fixture(
  request: () => Promise<ScreenLock> = async () => new Lock(),
  supported = true,
) {
  let visible = true,
    listener = () => {},
    requests = 0,
    detached = false;
  const statuses: WakeStatus[] = [],
    events: string[] = [];
  const controller = createWakeLock(
    {
      supported: () => supported,
      visible: () => visible,
      request: () => {
        requests++;
        return request();
      },
      onVisibility: (callback) => {
        listener = callback;
        return () => {
          detached = true;
        };
      },
    },
    (status) => statuses.push(status),
    (event) => events.push(event),
  );
  return {
    controller,
    statuses,
    events,
    requests: () => requests,
    detached: () => detached,
    visibility(value: boolean) {
      visible = value;
      listener();
    },
  };
}
test("Wake lock holds during work, releases on pause and cleanup, and reacquires only while visible", async () => {
  const locks: Lock[] = [];
  const f = fixture(async () => {
    const lock = new Lock();
    locks.push(lock);
    return lock;
  });
  f.controller.setActive(true);
  await tick();
  assert.equal(f.statuses.at(-1), "held");
  f.visibility(false);
  await tick();
  assert(locks[0].released);
  f.visibility(true);
  await tick();
  assert.equal(f.requests(), 2);
  f.controller.setActive(false);
  await tick();
  assert(locks[1].released);
  f.visibility(false);
  f.visibility(true);
  await tick();
  assert.equal(f.requests(), 2);
  f.controller.setActive(true);
  await tick();
  f.controller.dispose();
  await tick();
  assert(locks[2].released);
  assert(f.detached());
  assert(f.events.includes("wake.release"));
});
test("Pending wake requests cannot leak a lock after pause or React effect cleanup", async () => {
  for (const stop of ["pause", "dispose"] as const) {
    let resolve!: (lock: Lock) => void;
    const f = fixture(
      () =>
        new Promise((done) => {
          resolve = done;
        }),
    );
    f.controller.setActive(true);
    if (stop === "pause") f.controller.setActive(false);
    else f.controller.dispose();
    const lock = new Lock();
    resolve(lock);
    await tick();
    assert(lock.released);
    assert(!f.statuses.includes("held"));
    f.controller.dispose();
  }
});
test("Unsupported, denied or OS-revoked wake locks report a fallback without an infinite retry loop", async () => {
  const unsupported = fixture(undefined, false);
  unsupported.controller.setActive(true);
  assert.equal(unsupported.statuses.at(-1), "unsupported");
  assert.equal(unsupported.requests(), 0);
  unsupported.controller.dispose();
  const denied = fixture(async () => {
    throw new DOMException("private OS detail", "NotAllowedError");
  });
  denied.controller.setActive(true);
  await tick();
  assert.equal(denied.statuses.at(-1), "denied");
  assert.equal(denied.requests(), 1);
  denied.controller.dispose();
  const lock = new Lock(),
    f = fixture(async () => lock);
  f.controller.setActive(true);
  await tick();
  await lock.release();
  await tick();
  assert.equal(f.statuses.at(-1), "released");
  assert.equal(f.requests(), 1);
  f.controller.dispose();
});
