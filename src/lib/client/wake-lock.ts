export type WakeStatus =
  "idle" | "requesting" | "held" | "unsupported" | "denied" | "released";
export interface ScreenLock extends EventTarget {
  released: boolean;
  release(): Promise<void>;
}
export interface WakeEnvironment {
  supported(): boolean;
  visible(): boolean;
  request(): Promise<ScreenLock>;
  onVisibility(callback: () => void): () => void;
}
export function createWakeLock(
  environment: WakeEnvironment,
  update: (status: WakeStatus) => void,
  log: (
    event: string,
    details?: Record<string, string | number | boolean>,
  ) => void = () => {},
) {
  let active = false,
    disposed = false,
    generation = 0,
    sentinel: ScreenLock | null = null;
  async function release() {
    const lock = sentinel;
    sentinel = null;
    if (lock && !lock.released) {
      await lock.release().catch(() => {});
      log("wake.release");
    }
  }
  async function acquire() {
    if (!active || disposed || !environment.visible() || sentinel) return;
    const version = ++generation;
    if (!environment.supported()) {
      update("unsupported");
      log("wake.unsupported");
      return;
    }
    update("requesting");
    log("wake.request");
    try {
      const lock = await environment.request();
      if (
        !active ||
        disposed ||
        version !== generation ||
        !environment.visible()
      ) {
        await lock.release().catch(() => {});
        return;
      }
      sentinel = lock;
      lock.addEventListener(
        "release",
        () => {
          if (sentinel !== lock) return;
          sentinel = null;
          if (!disposed) update(active ? "released" : "idle");
          log("wake.released", { active });
          // No immediate retry loop: power-saving policies may keep rejecting it.
        },
        { once: true },
      );
      update("held");
      log("wake.held");
    } catch (error) {
      if (!disposed && version === generation && active) {
        update("denied");
        log("wake.denied", {
          name:
            error instanceof Error &&
            ["NotAllowedError", "AbortError", "NotSupportedError"].includes(
              error.name,
            )
              ? error.name
              : "WakeError",
        });
      }
    }
  }
  const detach = environment.onVisibility(() => {
    if (!environment.visible()) {
      generation++;
      void release();
      if (!disposed) update(active ? "released" : "idle");
    } else if (active) void acquire();
  });
  return {
    setActive(value: boolean) {
      active = value;
      if (value) void acquire();
      else {
        generation++;
        void release();
        if (!disposed) update("idle");
        log("wake.stopped");
      }
    },
    retry: () => void acquire(),
    dispose() {
      disposed = true;
      active = false;
      generation++;
      detach();
      void release();
    },
  };
}
