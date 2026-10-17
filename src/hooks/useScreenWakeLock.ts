"use client";
import { useEffect, useState } from "react";
import { createWakeLock, type WakeStatus } from "@/lib/client/wake-lock";
import { createAudioLog } from "@/lib/audio/diagnostics";
export function useScreenWakeLock(active: boolean, jobId?: string) {
  const [status, setStatus] = useState<WakeStatus>("idle");
  useEffect(() => {
    if (!active) {
      setStatus("idle");
      return;
    }
    const log = jobId ? createAudioLog(jobId) : () => {};
    const controller = createWakeLock(
      {
        supported: () =>
          typeof navigator !== "undefined" &&
          "wakeLock" in navigator &&
          globalThis.isSecureContext,
        visible: () => document.visibilityState === "visible",
        request: () => navigator.wakeLock.request("screen"),
        onVisibility: (callback) => {
          document.addEventListener("visibilitychange", callback);
          return () =>
            document.removeEventListener("visibilitychange", callback);
        },
      },
      setStatus,
      log,
    );
    controller.setActive(true);
    return () => controller.dispose();
  }, [active, jobId]);
  return status;
}
export const wakeLockMessage = (status: WakeStatus) =>
  status === "held"
    ? "Schermo mantenuto acceso durante l’elaborazione."
    : status === "requesting"
      ? "Attivazione dello schermo sempre acceso…"
      : "Schermo sempre acceso non disponibile: controlla il risparmio energetico e mantieni la pagina visibile.";
