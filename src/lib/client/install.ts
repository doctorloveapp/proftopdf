export const INSTALL_MARKER = "proftopdf:installed:v1";
export interface InstallPrompt extends Event {
  prompt(): Promise<void>;
  userChoice: Promise<{ outcome: "accepted" | "dismissed" }>;
}
export interface InstallState {
  installed: boolean;
  apple: boolean;
  mobile: boolean;
  canPrompt: boolean;
}
type Host = Pick<
  Window,
  "addEventListener" | "removeEventListener" | "matchMedia"
>;
type Device = Pick<Navigator, "userAgent" | "platform" | "maxTouchPoints"> & {
  standalone?: boolean;
};
type Store = Pick<Storage, "getItem" | "setItem">;

export function observeInstallation(
  host: Host,
  device: Device,
  store: Store | undefined,
  notify: (state: InstallState) => void,
) {
  const apple =
    /iPad|iPhone|iPod/.test(device.userAgent) ||
    (device.platform === "MacIntel" && device.maxTouchPoints > 1);
  const standalone = host.matchMedia("(display-mode: standalone)");
  let installed = standalone.matches || device.standalone === true;
  let pending: InstallPrompt | null = null;
  try {
    installed ||= store?.getItem(INSTALL_MARKER) === "true";
  } catch {}
  const publish = () =>
    notify({
      installed,
      apple,
      mobile: apple || /Android/i.test(device.userAgent),
      canPrompt: Boolean(pending),
    });
  const remember = () => {
    installed = true;
    pending = null;
    try {
      store?.setItem(INSTALL_MARKER, "true");
    } catch {}
    publish();
  };
  const before = (event: Event) => {
    event.preventDefault();
    if (standalone.matches || device.standalone) {
      remember();
      return;
    }
    // A fresh browser install event also allows reinstalling an uninstalled app.
    installed = false;
    pending = event as InstallPrompt;
    publish();
  };
  const displayChanged = () => {
    if (standalone.matches || device.standalone) remember();
  };
  const storageChanged = (event: Event) => {
    if (
      (event as StorageEvent).key === INSTALL_MARKER &&
      (event as StorageEvent).newValue === "true"
    )
      remember();
  };
  host.addEventListener("beforeinstallprompt", before);
  host.addEventListener("appinstalled", remember);
  host.addEventListener("storage", storageChanged);
  standalone.addEventListener("change", displayChanged);
  if (standalone.matches || device.standalone) remember();
  else publish();
  return {
    remember,
    async install(): Promise<
      "instructions" | "accepted" | "dismissed" | "failed"
    > {
      if (!pending) return "instructions";
      const event = pending;
      pending = null;
      publish();
      try {
        // Called synchronously from the user's tap, before awaiting anything.
        await event.prompt();
        const choice = await event.userChoice;
        if (choice.outcome === "accepted") remember();
        return choice.outcome;
      } catch {
        return "failed";
      }
    },
    dispose() {
      host.removeEventListener("beforeinstallprompt", before);
      host.removeEventListener("appinstalled", remember);
      host.removeEventListener("storage", storageChanged);
      standalone.removeEventListener("change", displayChanged);
    },
  };
}
