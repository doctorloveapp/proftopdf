"use client";

import Image from "next/image";
import { useEffect, useState, type FormEvent } from "react";
import { api, ClientApiError, type SessionInfo } from "@/lib/client/api";
import StudioWorkspace from "./StudioWorkspace";
import InstallApp from "./InstallApp";

export default function StudioApp() {
  const [session, setSession] = useState<SessionInfo | null>(null);
  const [checking, setChecking] = useState(true),
    [busy, setBusy] = useState(false);
  const [password, setPassword] = useState(""),
    [error, setError] = useState("");
  const [retryAt, setRetryAt] = useState<string | null>(null);
  useEffect(() => {
    const aborter = new AbortController();
    api<SessionInfo | { authenticated: false }>("/api/session", {
      signal: aborter.signal,
    })
      .then((result) => setSession(result.authenticated ? result : null))
      .catch((error) => {
        if (!aborter.signal.aborted)
          setError(
            error instanceof Error ? error.message : "Accesso non disponibile.",
          );
      })
      .finally(() => {
        if (!aborter.signal.aborted) setChecking(false);
      });
    return () => aborter.abort();
  }, []);
  useEffect(() => {
    if (!session) return;
    const timer = setTimeout(
      () => {
        setSession(null);
        setError(
          "La sessione è scaduta. Accedi di nuovo: le lezioni sono conservate sul dispositivo.",
        );
      },
      Math.max(0, Date.parse(session.expiresAt) - Date.now()),
    );
    return () => clearTimeout(timer);
  }, [session]);
  async function signIn(event: FormEvent) {
    event.preventDefault();
    if (busy) return;
    setBusy(true);
    setError("");
    setRetryAt(null);
    try {
      const result = await api<SessionInfo>("/api/session", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ password }),
      });
      setPassword("");
      setSession(result);
    } catch (error) {
      setError(
        error instanceof Error ? error.message : "Accesso non riuscito.",
      );
      if (error instanceof ClientApiError) setRetryAt(error.retryAt);
    } finally {
      setBusy(false);
    }
  }
  async function signOut() {
    if (!session || busy) return;
    setBusy(true);
    setError("");
    try {
      await api("/api/session", {
        method: "DELETE",
        headers: { "x-csrf-token": session.csrfToken },
      });
      setSession(null);
    } catch (error) {
      if (error instanceof ClientApiError && error.status === 401)
        setSession(null);
      else
        setError(
          error instanceof Error
            ? error.message
            : "Uscita non riuscita. Riprova.",
        );
    } finally {
      setBusy(false);
    }
  }
  return (
    <div className="site-shell">
      <a className="skip-link" href="#contenuto">
        Vai al contenuto
      </a>
      <header className="site-header">
        <a href="/" className="brand" aria-label="ProfToPdf, pagina iniziale">
          <Image
            src="/logo-navbar.webp"
            alt="ProfToPdf"
            width={236}
            height={42}
            priority
            unoptimized
          />
        </a>
        {session ? (
          <button
            className="text-button"
            disabled={busy}
            onClick={() => void signOut()}
          >
            {busy ? "Attendi…" : "Esci"} <span aria-hidden="true">↗</span>
          </button>
        ) : (
          <span className="header-caption">Il tuo spazio di studio</span>
        )}
      </header>
      <InstallApp />
      {checking ? (
        <main id="contenuto" className="auth-loading" role="status">
          Apertura del tuo spazio…
        </main>
      ) : session ? (
        <>
          <StudioWorkspace
            csrfToken={session.csrfToken}
            onSessionExpired={() => {
              setSession(null);
              setError("Accedi di nuovo per continuare.");
            }}
          />
          {error && (
            <p className="feedback feedback-error" role="alert">
              {error}
            </p>
          )}
        </>
      ) : (
        <main className="login-layout" id="contenuto">
          <section className="login-copy">
            <p className="eyebrow">MENO RIORDINO. PIÙ STUDIO.</p>
            <h1>
              Le tue lezioni.
              <br />
              <span>Il tuo filo logico.</span>
            </h1>
            <p className="hero-description">
              Raccogli le registrazioni, prepara l’audio e riparti dal lavoro
              già salvato. Un po’ più di ordine, prima del prossimo esame.
            </p>
            <div className="login-points">
              <span>01 &nbsp; Scegli la registrazione</span>
              <span>02 &nbsp; Prepara l’audio sul dispositivo</span>
              <span>03 &nbsp; Ritrova le tue lezioni</span>
            </div>
          </section>
          <section className="login-card" aria-labelledby="login-title">
            <p className="eyebrow">BENTORNATO</p>
            <h2 id="login-title">Entra nel tuo spazio.</h2>
            <p>Usa la password di accesso che ti è stata condivisa.</p>
            <form onSubmit={signIn}>
              <label htmlFor="access-password">Password di accesso</label>
              <input
                id="access-password"
                type="password"
                value={password}
                onChange={(event) => setPassword(event.target.value)}
                autoComplete="current-password"
                maxLength={256}
                required
                aria-describedby={error ? "login-error" : undefined}
                disabled={busy}
              />
              <button
                className="button full-width"
                disabled={busy || !password}
              >
                {busy ? "Accesso in corso…" : "Accedi"}{" "}
                <span aria-hidden="true">→</span>
              </button>
            </form>
            {error && (
              <p
                id="login-error"
                className="feedback feedback-error"
                role="alert"
              >
                {error}
                {retryAt && (
                  <span>
                    {" "}
                    Puoi riprovare dalle{" "}
                    {new Date(retryAt).toLocaleTimeString("it-IT", {
                      hour: "2-digit",
                      minute: "2-digit",
                    })}
                    .
                  </span>
                )}
              </p>
            )}
            <p className="local-note">
              Le registrazioni preparate sono conservate in questo browser. Su
              un dispositivo condiviso, elimina le lezioni prima di lasciarlo.
            </p>
          </section>
        </main>
      )}
      <footer className="site-footer">
        <span>ProfToPdf</span>
        <p>Trascrivi le tue lezioni</p>
        <span className="footer-note">Le tue lezioni, in ordine.</span>
      </footer>
    </div>
  );
}
