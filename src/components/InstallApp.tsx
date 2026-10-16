"use client";
import { useEffect, useRef, useState } from "react";
import { observeInstallation, type InstallState } from "@/lib/client/install";

export default function InstallApp() {
  const [state, setState] = useState<InstallState | null>(null);
  const [instructions, setInstructions] = useState(false);
  const [prompting, setPrompting] = useState(false);
  const [error, setError] = useState("");
  const manager = useRef<ReturnType<typeof observeInstallation> | null>(null);
  useEffect(() => {
    let storage: Storage | undefined;
    try {
      storage = localStorage;
    } catch {}
    manager.current = observeInstallation(window, navigator, storage, setState);
    // Network-only worker: installation support without caching private pages,
    // audio, API responses or a stale application shell.
    if ("serviceWorker" in navigator) {
      navigator.serviceWorker
        .register("/sw.js", { scope: "/", updateViaCache: "none" })
        .catch(() =>
          setError(
            "Installazione non disponibile ora. Riprova dal menu del browser.",
          ),
        );
    }
    return () => {
      manager.current?.dispose();
      manager.current = null;
    };
  }, []);
  if (!state || state.installed || (!state.mobile && !state.canPrompt))
    return null;
  async function install() {
    if (!manager.current) return;
    setError("");
    setPrompting(true);
    const outcome = await manager.current.install();
    setPrompting(false);
    setInstructions(outcome === "instructions" || outcome === "failed");
    if (outcome === "failed")
      setError(
        "Il browser non ha aperto l’installazione. Puoi usare questi passaggi.",
      );
  }
  return (
    <div className="install-app">
      <button
        className="text-button"
        type="button"
        disabled={prompting}
        aria-expanded={instructions}
        aria-controls="install-instructions"
        onClick={() => void install()}
      >
        {prompting ? "Apertura installazione…" : "Installa ProfToPdf"}
      </button>
      {instructions && (
        <div
          id="install-instructions"
          className="install-instructions"
          role="region"
          aria-label="Installare ProfToPdf"
        >
          <strong>ProfToPdf sulla schermata Home</strong>
          {state.apple ? (
            <ol>
              <li>Apri questa pagina in Safari.</li>
              <li>Tocca Condividi, poi Aggiungi alla schermata Home.</li>
              <li>
                Se presente, attiva Apri come app web, poi tocca Aggiungi.
              </li>
              <li>Apri ProfToPdf dalla nuova icona.</li>
            </ol>
          ) : (
            <ol>
              <li>Apri il menu ⋮ di Chrome.</li>
              <li>
                Tocca Aggiungi a schermata Home, poi Installa, se richiesto.
              </li>
              <li>Apri ProfToPdf dalla nuova icona.</li>
            </ol>
          )}
          <p>
            Le lezioni restano nel browser in cui le hai create. Su Apple l’app
            installata può avere un archivio separato: conserva audio ed export.
          </p>
          {error && <p role="status">{error}</p>}
          <div className="job-actions">
            <button
              className="text-button"
              onClick={() => manager.current?.remember()}
            >
              Ho aggiunto l’app alla Home
            </button>
            <button
              className="text-button"
              onClick={() => setInstructions(false)}
            >
              Chiudi
            </button>
          </div>
        </div>
      )}
    </div>
  );
}
