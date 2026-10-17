"use client";

import { useEffect, useRef, useState } from "react";
import { useAudioJob } from "@/hooks/useAudioJob";
import { api, ClientApiError } from "@/lib/client/api";
import { AUDIO_ACCEPT, validateFile } from "@/lib/pipeline/prepare-audio";
import { removeJob, saveJob, type LocalJob } from "@/lib/storage/jobs";
import { importCheckpoint, exportCheckpoint } from "@/lib/storage/checkpoint";
import { exportAudioLog, removeAudioLog } from "@/lib/audio/diagnostics";
import type { QuotaState, ProcessingStage } from "@/lib/shared/types";
import QuotaMeter from "./QuotaMeter";
import ProcessingPanel from "./ProcessingPanel";
import { SUBJECTS } from "@/lib/shared/lecture";
import { scrollToControl } from "@/lib/client/scroll";
import { useScreenWakeLock, wakeLockMessage } from "@/hooks/useScreenWakeLock";

const labels: Partial<Record<ProcessingStage, string>> = {
  selected: "Da preparare",
  analyzing: "Analisi del file",
  preparing: "Preparazione",
  paused: "In pausa",
  failed: "Da riprendere",
  ready: "Audio pronto",
  cancelled: "Annullata",
  transcribing: "Trascrizione",
  "waiting-quota": "In attesa della quota",
  "generating-notes": "Creazione dispensa",
  completed: "Dispensa pronta",
};
const size = (bytes: number) => `${(bytes / 1_000_000).toFixed(1)} MB`;
const minutes = (seconds: number) => `${Math.ceil(seconds / 60)} min`;

export default function StudioWorkspace({
  onSessionExpired,
  csrfToken,
}: {
  onSessionExpired: () => void;
  csrfToken: string;
}) {
  const state = useAudioJob();
  const [editorOpen, setEditorOpen] = useState(false);
  const [file, setFile] = useState<File | null>(null);
  const [title, setTitle] = useState(""),
    [subject, setSubject] = useState("");
  const [dragging, setDragging] = useState(false);
  const [quotas, setQuotas] = useState<{
    transcription: QuotaState;
    notes: QuotaState;
    notesProviders?: QuotaState[];
  } | null>(null);
  const [quotaError, setQuotaError] = useState(""),
    [notice, setNotice] = useState("");
  const [loadingQuota, setLoadingQuota] = useState(false),
    [storageBusy, setStorageBusy] = useState(false);
  const picker = useRef<HTMLInputElement>(null),
    checkpointPicker = useRef<HTMLInputElement>(null);
  const selected = state.jobs.find(
    (entry) => entry.job.id === state.selectedId,
  );
  const wakeStatus = useScreenWakeLock(
    state.busy,
    state.selectedId ?? undefined,
  );
  async function refreshQuota() {
    setLoadingQuota(true);
    setQuotaError("");
    try {
      setQuotas(await api("/api/quota"));
    } catch (error) {
      setQuotas(null);
      if (error instanceof ClientApiError && error.status === 401)
        onSessionExpired();
      else
        setQuotaError(
          error instanceof Error ? error.message : "Quota non disponibile.",
        );
    } finally {
      setLoadingQuota(false);
    }
  }
  useEffect(() => {
    void refreshQuota();
  }, []);
  useEffect(() => {
    if (!state.quotaRevision) return;
    const timer = setTimeout(
      () => void refreshQuota(),
      state.busy ? 15_000 : 0,
    );
    return () => clearTimeout(timer);
  }, [state.quotaRevision, state.busy]);
  useEffect(() => {
    if (selected?.job.error?.code === "UNAUTHENTICATED") onSessionExpired();
  }, [selected?.job.error?.code, onSessionExpired]);
  function chooseFile(candidate: File | undefined) {
    if (!candidate || state.busy) return;
    try {
      validateFile(candidate);
      setFile(candidate);
      setNotice("");
      state.setError("");
    } catch (error) {
      state.setError(
        error instanceof Error ? error.message : "File non valido.",
      );
    }
  }
  function newLesson() {
    if (state.busy || storageBusy) return;
    resetLesson();
    setEditorOpen(true);
    scrollToControl("audio-picker-button", true);
  }
  function resetLesson() {
    setEditorOpen(false);
    state.setSelectedId(null);
    setFile(null);
    setTitle("");
    setSubject("");
    setNotice("");
    state.setError("");
  }
  function selectLesson(local: LocalJob) {
    if (state.busy) return;
    state.setSelectedId(local.job.id);
    setEditorOpen(true);
    setFile(null);
    setNotice("");
    state.setError("");
    scrollToControl("lesson-workspace", true);
  }
  async function deleteSelected() {
    if (!selected || storageBusy) return;
    if (
      !window.confirm(
        `Eliminare la lezione “${selected.title}” e tutti i suoi dati locali?\n\nL’elaborazione verrà interrotta. Il file audio originale sul telefono non verrà cancellato.`,
      )
    )
      return;
    const id = selected.job.id;
    setStorageBusy(true);
    try {
      await state.stopAndWait();
      // Revoke any other tab's lease in the same transaction as deletion.
      await removeJob(id, { interrupt: true });
      removeAudioLog(id);
      resetLesson(); // unmount ProcessingPanel, terminating a PDF worker too
      await state.refresh();
      let remoteRemoved = true;
      try {
        await api(`/api/jobs/${id}`, {
          method: "DELETE",
          headers: { "x-csrf-token": csrfToken },
        });
      } catch {
        remoteRemoved = false;
      }
      setNotice(
        remoteRemoved
          ? "Lezione, segmenti locali e cache temporanea della sessione eliminati."
          : "Dati locali eliminati. La cache remota non è raggiungibile e scadrà automaticamente entro 15 minuti.",
      );
    } catch (error) {
      state.setError(
        error instanceof Error ? error.message : "Eliminazione non riuscita.",
      );
    } finally {
      setStorageBusy(false);
    }
  }
  async function restoreCheckpoint(candidate: File | undefined) {
    if (!candidate || state.busy || storageBusy) return;
    setStorageBusy(true);
    try {
      if (candidate.size > 2_000_000)
        throw new Error("Il checkpoint supera il limite di 2 MB.");
      const local = importCheckpoint(await candidate.text());
      await saveJob(local);
      await state.refresh();
      selectLesson(local);
      setNotice(
        "Checkpoint importato. Seleziona il file audio originale per ricreare i segmenti sul dispositivo.",
      );
    } catch (error) {
      state.setError(
        error instanceof Error ? error.message : "Checkpoint non valido.",
      );
    } finally {
      setStorageBusy(false);
      if (checkpointPicker.current) checkpointPicker.current.value = "";
    }
  }
  function downloadCheckpoint() {
    if (!selected?.manifest.source.sha256) return;
    const url = URL.createObjectURL(
      new Blob([exportCheckpoint(selected)], { type: "application/json" }),
    );
    const link = document.createElement("a");
    link.href = url;
    link.download = `ProfToPdf-${selected.title.replace(/[^a-zA-Z0-9_-]/g, "_").slice(0, 80)}.json`;
    document.body.append(link);
    link.click();
    link.remove();
    setTimeout(() => URL.revokeObjectURL(url), 30_000);
  }
  function downloadDiagnostics() {
    if (!selected) return;
    try {
      const url = URL.createObjectURL(
        new Blob(
          [
            exportAudioLog(
              selected.job.id,
              selected.processing?.notesUsage,
              selected.processing?.usageHistoryComplete,
            ),
          ],
          {
            type: "application/json",
          },
        ),
      );
      const link = document.createElement("a");
      link.href = url;
      link.download = `ProfToPdf-log-${selected.job.id.slice(0, 8)}.json`;
      document.body.append(link);
      link.click();
      link.remove();
      setTimeout(() => URL.revokeObjectURL(url), 30_000);
      setNotice(
        "Log diagnostico scaricato. Contiene tempi, fasi ed errori tecnici; puoi condividerlo per l’analisi.",
      );
    } catch (error) {
      state.setError(
        error instanceof Error ? error.message : "Log non disponibile.",
      );
    }
  }
  const audioQuota = quotas?.transcription.windows.find(
    (window) =>
      window.resource === "audio-seconds" && window.windowSeconds === 86_400,
  );
  const hourlyQuota = quotas?.transcription.windows.find(
    (window) =>
      window.resource === "audio-seconds" && window.windowSeconds === 3_600,
  );
  const selectedEnd =
    selected?.manifest.chunks
      .filter((chunk) => selected.preparedChunkIds.includes(chunk.id))
      .at(-1)?.endSeconds ?? 0;
  const fraction =
    state.progress?.fraction ??
    (selected?.manifest.source.durationSeconds
      ? selectedEnd / selected.manifest.source.durationSeconds
      : 0);
  const LibraryHeading = editorOpen ? "h2" : "h1";

  return (
    <main className="studio-main" id="contenuto">
      {editorOpen && (
        <div className="studio-intro">
          <div>
            <p className="eyebrow">IL TUO SPAZIO DI STUDIO</p>
            <h1>
              Una lezione.
              <br />
              <span>Un nuovo punto di partenza.</span>
            </h1>
          </div>
          <p>
            Prepara la registrazione sul tuo dispositivo.
            <br />
            Ritroverai qui il lavoro già salvato.
          </p>
        </div>
      )}
      <div className={`studio-grid${editorOpen ? "" : " is-library"}`}>
        <aside className="lessons-panel" aria-label="Lezioni salvate">
          <div className="panel-heading">
            <LibraryHeading>Le tue lezioni</LibraryHeading>
            <span>{state.jobs.length}</span>
          </div>
          <button
            className="button button-secondary full-width"
            onClick={newLesson}
            disabled={state.busy || storageBusy}
          >
            + Nuova lezione
          </button>
          {!editorOpen && state.error && (
            <div className="feedback feedback-error" role="alert">
              {state.error}
            </div>
          )}
          {!editorOpen && notice && (
            <div className="feedback" role="status">
              {notice}
            </div>
          )}
          <div className="lesson-list">
            {state.jobs.length === 0 ? (
              <p className="empty-list">
                Il tuo archivio inizia dalla prima registrazione.
              </p>
            ) : (
              state.jobs.map((local) => (
                <button
                  key={local.job.id}
                  onClick={() => selectLesson(local)}
                  disabled={state.busy}
                  className={`lesson-item ${local.job.id === state.selectedId ? "is-selected" : ""}`}
                >
                  <strong>{local.title}</strong>
                  <span>
                    {labels[local.job.stage] ?? local.job.stage} ·{" "}
                    {size(local.manifest.source.byteLength)}
                  </span>
                </button>
              ))
            )}
          </div>
          <button
            className="text-button"
            disabled={state.busy || storageBusy}
            onClick={() => checkpointPicker.current?.click()}
          >
            Importa un checkpoint
          </button>
          <input
            ref={checkpointPicker}
            type="file"
            accept=".json,application/json"
            hidden
            onChange={(event) =>
              void restoreCheckpoint(event.target.files?.[0])
            }
          />
          <p className="local-note">
            Salvate in questo browser. Uscire dall’account non elimina le
            lezioni dal dispositivo.
          </p>
          <p className="local-note">
            Il checkpoint salva solo metadati e confini audio. Per ripartire
            serve l’originale; non contiene audio, appunti o PDF.
          </p>
        </aside>
        <section className="quota-panel" aria-labelledby="quota-title">
          <div className="panel-heading">
            <h2 id="quota-title">Disponibilità residua</h2>
            <button
              className="text-button"
              disabled={loadingQuota}
              onClick={() => void refreshQuota()}
            >
              {loadingQuota ? "Aggiornamento…" : "Aggiorna"}
            </button>
          </div>
          <div className="quota-values">
            <div>
              <span>Audio nelle ultime 24 ore</span>
              <strong>
                {audioQuota
                  ? `${Math.floor(audioQuota.remaining / 60)} min`
                  : "—"}
              </strong>
              <p>
                {hourlyQuota
                  ? `${Math.floor(hourlyQuota.remaining / 60)} min disponibili nella finestra oraria.`
                  : "Quota residua per tutte le lezioni."}
              </p>
              <QuotaMeter
                window={audioQuota}
                label="Audio utilizzato nelle ultime 24 ore"
              />
            </div>
            {(quotas?.notesProviders ?? (quotas ? [quotas.notes] : [])).map(
              (provider) => {
                const daily = provider.windows.find(
                  (window) => window.windowSeconds === 86400,
                );
                const label =
                  provider.provider === "openai"
                    ? "OpenAI · motore principale"
                    : provider.provider === "openrouter"
                      ? "OpenRouter · prima riserva gratuita"
                      : "Groq · seconda riserva gratuita";
                return (
                  <div key={provider.provider}>
                    <span>{label}</span>
                    <strong>
                      {daily
                        ? daily.resource === "micro-usd"
                          ? `$${(daily.remaining / 1e6).toFixed(2)}`
                          : daily.resource === "requests"
                            ? `${daily.remaining} richieste`
                            : `${Math.floor(daily.remaining / 1000)} mila token`
                        : "—"}
                    </strong>
                    <p>
                      {provider.provider === "openai"
                        ? "Budget applicativo residuo nelle 24 ore; non è il saldo del conto OpenAI."
                        : "Capacità condivisa nelle ultime 24 ore."}
                    </p>
                    <QuotaMeter
                      window={daily}
                      label={`${label}: capacità utilizzata`}
                    />
                  </div>
                );
              },
            )}
          </div>
          {quotaError && (
            <p role="alert" className="quota-error">
              {quotaError}
            </p>
          )}
          {quotas && (
            <p className="local-note">
              {!quotas.transcription.available || !quotas.notes.available
                ? "Alcune elaborazioni non sono disponibili ora. Puoi comunque preparare l’audio localmente."
                : "Quote condivise tra gli utenti su finestre mobili: si liberano progressivamente, senza reset a mezzanotte. La parte tratteggiata indica prenotazioni ancora conteggiate. La quota residua deve bastare per l’intera richiesta successiva."}
            </p>
          )}
        </section>
        {editorOpen && (
          <section
            id="lesson-workspace"
            tabIndex={-1}
            className="upload-panel"
            aria-labelledby="upload-title"
          >
            <button
              className="text-button back-to-library"
              disabled={state.busy || storageBusy}
              onClick={resetLesson}
            >
              ← Le tue lezioni
            </button>
            <div className="panel-heading">
              <div>
                <p className="eyebrow">
                  {selected ? "LA TUA REGISTRAZIONE" : "COMINCIAMO DALL’AUDIO"}
                </p>
                <h2 id="upload-title">
                  {selected?.title ?? "Aggiungi una lezione"}
                </h2>
              </div>
              {selected && (
                <span
                  className={`status-badge ${["ready", "completed"].includes(selected.job.stage) ? "is-ready" : ""}`}
                >
                  {labels[selected.job.stage] ?? selected.job.stage}
                </span>
              )}
            </div>
            {selected && (
              <div className="file-summary">
                <span aria-hidden="true">♫</span>
                <div>
                  <strong>{selected.manifest.source.name}</strong>
                  <p>
                    {size(selected.manifest.source.byteLength)}
                    {selected.manifest.source.durationSeconds > 0 &&
                      ` · ${minutes(selected.manifest.source.durationSeconds)}`}{" "}
                    · {selected.subject || "Lezione universitaria"}
                  </p>
                </div>
              </div>
            )}
            {(!selected ||
              (selected.job.stage !== "ready" &&
                !selected.processing &&
                !state.busy) ||
              (!state.busy &&
                [
                  "LOCAL_AUDIO_MISSING",
                  "AUDIO_NORMALIZATION_REQUIRED",
                ].includes(selected.job.error?.code ?? ""))) && (
              <>
                <div
                  className={`drop-zone ${dragging ? "is-dragging" : ""}`}
                  onDragOver={(event) => {
                    event.preventDefault();
                    if (!state.busy) setDragging(true);
                  }}
                  onDragLeave={() => setDragging(false)}
                  onDrop={(event) => {
                    event.preventDefault();
                    setDragging(false);
                    if (event.dataTransfer.files.length > 1)
                      state.setError("Seleziona una registrazione alla volta.");
                    else chooseFile(event.dataTransfer.files[0]);
                  }}
                >
                  <span className="upload-symbol" aria-hidden="true">
                    ↑
                  </span>
                  <h3>
                    {file
                      ? file.name
                      : selected
                        ? "Ritrova il file originale"
                        : "La registrazione è qui che inizia."}
                  </h3>
                  <p>
                    {file
                      ? `${size(file.size)} · pronto per la verifica`
                      : "Scegli un audio dal dispositivo, oppure trascinalo qui."}
                  </p>
                  <button
                    id="audio-picker-button"
                    className="button"
                    type="button"
                    onClick={() => {
                      if (picker.current) picker.current.value = "";
                      picker.current?.click();
                    }}
                    disabled={state.busy}
                  >
                    {file ? "Cambia file" : "Scegli la registrazione"}
                  </button>
                  <span className="format-note">
                    M4A, AAC, MP3, WAV, FLAC, Ogg, WebM · fino a 120 MB / 120
                    min
                  </span>
                  <input
                    ref={picker}
                    type="file"
                    accept={AUDIO_ACCEPT}
                    hidden
                    onChange={(event) => chooseFile(event.target.files?.[0])}
                  />
                </div>
                {!selected && (
                  <div className="lesson-fields">
                    <label>
                      Titolo della lezione
                      <input
                        value={title}
                        onChange={(event) => setTitle(event.target.value)}
                        maxLength={200}
                        placeholder="Es. Introduzione alla psicologia"
                      />
                    </label>
                    <label>
                      Materia <span>(facoltativa)</span>
                      <input
                        value={subject}
                        onChange={(event) => setSubject(event.target.value)}
                        maxLength={200}
                        list="lesson-subjects"
                        placeholder="Scegli o scrivi una materia"
                      />
                      <datalist id="lesson-subjects">
                        {SUBJECTS.map((entry) => (
                          <option key={entry} value={entry} />
                        ))}
                      </datalist>
                    </label>
                  </div>
                )}
                <p className="local-note">
                  La preparazione avviene sul dispositivo. Avviando la
                  trascrizione, i segmenti saranno inviati a Groq tramite
                  ProfToPdf. Le lingue parlate vengono conservate senza
                  traduzione automatica.
                </p>
                <button
                  className="button prepare-button"
                  disabled={!file || state.busy || storageBusy}
                  onClick={() => {
                    if (file) {
                      void state.start(file, title, subject, selected);
                      scrollToControl("lecture-progress", true);
                    }
                  }}
                >
                  {selected?.job.error?.code === "AUDIO_NORMALIZATION_REQUIRED"
                    ? "Prepara versione WAV compatibile"
                    : selected
                      ? "Riprendi la preparazione"
                      : "Prepara la lezione"}{" "}
                  <span aria-hidden="true">→</span>
                </button>
              </>
            )}
            {state.busy ||
            selected?.preparedChunkIds.length ||
            selected?.job.stage === "ready" ? (
              <div
                id="lecture-progress"
                tabIndex={-1}
                className="progress-card"
                aria-live="polite"
              >
                <div className="progress-heading">
                  <strong>
                    {state.busy
                      ? (state.progress?.message ?? "Preparazione in corso")
                      : selected?.job.stage === "completed"
                        ? "La dispensa è pronta."
                        : selected?.job.stage === "ready"
                          ? "La registrazione è pronta."
                          : "Ripartiamo dal lavoro salvato."}
                  </strong>
                  <span>
                    {state.progress?.fraction === null
                      ? "In corso"
                      : `${Math.floor(fraction * 100)}%`}
                  </span>
                </div>
                {state.progress?.fraction === null ? (
                  <progress aria-label="Analisi del formato audio" />
                ) : (
                  <progress
                    max={1}
                    value={fraction}
                    aria-label={
                      state.progress?.stage === "analyzing"
                        ? "Verifica del file"
                        : "Preparazione audio"
                    }
                  />
                )}
                <p>
                  {selected?.preparedChunkIds.length ?? 0} segmenti salvati sul
                  dispositivo.{" "}
                  {state.busy
                    ? "Tieni questa pagina aperta: cambiando app la preparazione va in pausa."
                    : selected?.job.stage === "completed"
                      ? "Appunti salvati. Puoi modificarli e scaricare il PDF."
                      : selected?.job.stage === "ready"
                        ? "Puoi avviare la trascrizione e creare la dispensa."
                        : selected?.job.retryAt
                          ? `Quota insufficiente: lavoro salvato. Riprendi dal ${new Date(selected.job.retryAt).toLocaleString("it-IT")}. Puoi chiudere l’app durante l’attesa.`
                          : selected?.processing
                            ? "Il lavoro è salvato: usa Riprendi per continuare."
                            : "Per riprendere, seleziona la stessa registrazione."}
                </p>
                {state.busy && (
                  <p className="local-note">{wakeLockMessage(wakeStatus)}</p>
                )}
                {state.busy && (
                  <div className="job-actions">
                    <button
                      className="button button-secondary"
                      onClick={state.pause}
                    >
                      Metti in pausa
                    </button>
                    <button
                      className="text-button danger"
                      onClick={state.cancel}
                    >
                      Annulla elaborazione
                    </button>
                  </div>
                )}
              </div>
            ) : null}
            {(state.error || selected?.job.error?.message) && (
              <div className="feedback feedback-error" role="alert">
                {state.error || selected?.job.error?.message}
              </div>
            )}
            {notice && (
              <div className="feedback" role="status">
                {notice}
              </div>
            )}
            {selected && (
              <div className="job-actions">
                <button className="text-button" onClick={downloadDiagnostics}>
                  Scarica log diagnostico
                </button>
              </div>
            )}
            {selected && (
              <ProcessingPanel
                local={selected}
                busy={state.busy || storageBusy}
                csrfToken={csrfToken}
                key={selected.job.id}
                onProcess={(options) => {
                  void state.process(selected, csrfToken, options);
                  scrollToControl("lecture-progress", true);
                }}
                onSaved={state.refresh}
                onError={(message) => state.setError(message)}
              />
            )}
            {selected && (
              <div className="job-actions">
                <button
                  className="text-button"
                  disabled={
                    state.busy ||
                    !selected.manifest.source.sha256 ||
                    storageBusy
                  }
                  onClick={downloadCheckpoint}
                >
                  Esporta checkpoint
                </button>
                <button
                  className="text-button danger"
                  disabled={storageBusy}
                  onClick={() => void deleteSelected()}
                >
                  {storageBusy ? "Eliminazione…" : "Elimina lezione"}
                </button>
              </div>
            )}
          </section>
        )}
      </div>
    </main>
  );
}
