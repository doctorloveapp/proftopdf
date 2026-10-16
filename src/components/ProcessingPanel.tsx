"use client";
import { useEffect, useMemo, useRef, useState } from "react";
import ReactMarkdown from "react-markdown";
import {
  acquireLease,
  releaseLease,
  saveMarkdownDraft,
  type LocalJob,
} from "@/lib/storage/jobs";
import { documentMarkdown } from "@/lib/notes/markdown";
import {
  mergeTranscripts,
  transcriptText,
  timestamp,
} from "@/lib/transcription/merge";
import { createAudioLog } from "@/lib/audio/diagnostics";
import type { ProcessingOptions } from "@/lib/pipeline/process-lecture";
import { documentFileStem } from "@/lib/pdf/naming";
import { scrollToControl } from "@/lib/client/scroll";

function download(blob: Blob, name: string) {
  const url = URL.createObjectURL(blob),
    link = document.createElement("a");
  link.href = url;
  link.download = name;
  document.body.append(link);
  link.click();
  link.remove();
  setTimeout(() => URL.revokeObjectURL(url), 30000);
}
export default function ProcessingPanel({
  local,
  busy,
  onProcess,
  onSaved,
  onError,
}: {
  local: LocalJob;
  busy: boolean;
  csrfToken: string;
  onProcess: (options?: ProcessingOptions) => void;
  onSaved: () => Promise<void>;
  onError: (message: string) => void;
}) {
  const [editing, setEditing] = useState(false),
    [saving, setSaving] = useState(false);
  const [pdfBusy, setPdfBusy] = useState(false),
    [pdfUrl, setPdfUrl] = useState("");
  const pdfController = useRef<AbortController | null>(null);
  const mounted = useRef(true);
  const data = local.processing,
    lecture = data?.document;
  const markdown = useMemo(
    () => data?.markdownDraft ?? (lecture ? documentMarkdown(lecture) : ""),
    [data?.markdownDraft, lecture],
  );
  const [draft, setDraft] = useState(markdown);
  useEffect(() => {
    setDraft(markdown);
    setEditing(false);
    setPdfUrl("");
  }, [markdown]);
  useEffect(() => {
    mounted.current = true;
    return () => {
      mounted.current = false;
      pdfController.current?.abort();
    };
  }, []);
  useEffect(() => {
    if (pdfUrl) scrollToControl("pdf-download", true);
  }, [pdfUrl]);
  useEffect(
    () => () => {
      if (pdfUrl) URL.revokeObjectURL(pdfUrl);
    },
    [pdfUrl],
  );
  const segments = useMemo(
    () => (data ? mergeTranscripts(local.manifest, data.transcripts) : []),
    [local.manifest, data],
  );
  const transcript = useMemo(() => transcriptText(segments), [segments]);
  const completeAudio =
    local.manifest.chunks.length > 0 &&
    local.manifest.chunks.every(
      (c) =>
        local.preparedChunkIds.includes(c.id) ||
        data?.transcripts[c.id]?.sha256 === c.sha256,
    );
  const failed = local.job.stage === "failed";
  const hasFailure =
    data?.failedChunkIndex !== undefined || Boolean(data?.failedUnitId);
  const filename = documentFileStem(
    lecture ?? {
      title: local.title,
      subject: local.subject,
      createdAt: local.job.createdAt,
    },
  );
  async function saveDraft() {
    if (!data || !lecture) return;
    if (new TextEncoder().encode(draft).length > 2_000_000) {
      onError("Gli appunti modificati superano il limite di 2 MB.");
      return;
    }
    setSaving(true);
    let token: string | undefined;
    try {
      token = await acquireLease(local.job.id);
      await saveMarkdownDraft(local.job.id, draft, lecture.updatedAt, token);
      await onSaved();
      setEditing(false);
    } catch (error) {
      onError(
        error instanceof Error ? error.message : "Salvataggio non riuscito.",
      );
    } finally {
      if (token) await releaseLease(local.job.id, token).catch(() => {});
      setSaving(false);
    }
  }
  async function preparePdf() {
    if (!lecture || pdfBusy) return;
    setPdfBusy(true);
    scrollToControl("pdf-progress", true);
    const controller = new AbortController();
    pdfController.current = controller;
    const log = createAudioLog(local.job.id);
    log("pdf.start", { sections: lecture.sections.length });
    try {
      const { createPdf } = await import("@/lib/pdf/client");
      const blob = await createPdf(lecture, markdown, controller.signal);
      if (!mounted.current) return;
      setPdfUrl(URL.createObjectURL(blob));
      log("pdf.complete", { bytes: blob.size });
    } catch (error) {
      if (!mounted.current) return;
      if (!controller.signal.aborted) {
        const cause =
          error instanceof Error
            ? (error.cause as
                | {
                    code?: string;
                    nativeName?: string;
                    technicalMessage?: string;
                  }
                | undefined)
            : undefined;
        log(
          "pdf.failed",
          {
            code: cause?.code ?? "PDF_RENDER_FAILED",
            nativeName: cause?.nativeName ?? "Error",
            technicalMessage: cause?.technicalMessage ?? "",
          },
          "error",
        );
        onError(
          error instanceof Error ? error.message : "PDF non disponibile.",
        );
      } else log("pdf.cancelled");
    } finally {
      if (mounted.current) setPdfBusy(false);
      pdfController.current = null;
    }
  }
  if (!completeAudio && !data) return null;
  return (
    <section className="processing-panel" aria-label="Trascrizione e dispensa">
      {!lecture && !busy && (
        <>
          <h3>
            {data ? "Riprendi la tua dispensa" : "Dall’audio agli appunti"}
          </h3>
          <p className="local-note">
            I segmenti verranno inviati a Groq tramite ProfToPdf. La
            trascrizione sarà poi elaborata per creare gli appunti. Il testo
            resta in questo browser e in una cache server privata per massimo 15
            minuti. Le quote gratuite possono richiedere attese: tieni la pagina
            aperta oppure riprendi più tardi.
          </p>
          <button
            className="button full-width"
            disabled={!completeAudio || saving || pdfBusy}
            onClick={() => onProcess()}
          >
            {data
              ? "Riprendi / recupera il risultato"
              : "Trascrivi e crea il Pdf"}
          </button>
          {failed && hasFailure && (
            <div className="recovery-actions">
              <p className="local-note">
                Il recupero usa la stessa richiesta. Un nuovo tentativo può
                consumare altra quota, anche se una risposta precedente è andata
                persa.
              </p>
              <button
                className="button button-secondary"
                disabled={saving}
                onClick={() => onProcess({ newAttempt: true })}
              >
                Autorizza un nuovo tentativo
              </button>
              {data?.failedChunkIndex !== undefined && (
                <>
                  <button
                    className="text-button"
                    disabled={saving}
                    onClick={() => onProcess({ accurate: true })}
                  >
                    Riprova questo segmento con Whisper V3
                  </button>
                  {![
                    "QUOTA_EXHAUSTED",
                    "PROVIDER_RATE_LIMIT",
                    "PROVIDER_COOLDOWN",
                    "LOCAL_AUDIO_MISSING",
                    "AUDIO_NORMALIZATION_REQUIRED",
                    "UNAUTHENTICATED",
                  ].includes(local.job.error?.code ?? "") && (
                    <button
                      className="text-button danger"
                      disabled={saving}
                      onClick={() => onProcess({ skipFailed: true })}
                    >
                      Segna il segmento come mancante e continua
                    </button>
                  )}
                </>
              )}
            </div>
          )}
        </>
      )}
      {data && (
        <p className="local-note">
          {
            Object.values(data.transcripts).filter(
              (r) => r.status === "transcribed",
            ).length
          }{" "}
          di {local.manifest.chunks.length} segmenti trascritti ·{" "}
          {Object.keys(data.notes).length} unità di appunti salvate.
        </p>
      )}
      {transcript && (
        <details className="transcript-panel">
          <summary>Trascrizione e riferimenti temporali</summary>
          <button
            className="text-button"
            onClick={() =>
              download(
                new Blob([transcript], { type: "text/plain;charset=utf-8" }),
                `${filename}-trascrizione.txt`,
              )
            }
          >
            Scarica trascrizione
          </button>
          <pre>{transcript}</pre>
        </details>
      )}
      {lecture && (
        <>
          <div className="panel-heading">
            <h3>
              {lecture.complete ? "La tua dispensa" : "Dispensa parziale"}
            </h3>
            <span className="status-badge">
              {lecture.sections.filter((s) => s.level === 1).length} capitoli
            </span>
          </div>
          {lecture.gaps.length > 0 && (
            <p className="feedback" role="status">
              Sono presenti {lecture.gaps.length} passaggi da verificare nella
              registrazione originale. I riferimenti sono riportati negli
              appunti e nel PDF.
            </p>
          )}
          <div className="job-actions">
            <button
              className="text-button"
              disabled={busy || pdfBusy || saving}
              onClick={() => {
                setDraft(markdown);
                setEditing(!editing);
              }}
            >
              {" "}
              {editing ? "Annulla modifiche" : "Modifica appunti"}
            </button>
            <button
              className="text-button"
              disabled={editing}
              onClick={() =>
                download(
                  new Blob([markdown], { type: "text/markdown;charset=utf-8" }),
                  `${filename}.md`,
                )
              }
            >
              Scarica Markdown
            </button>
            {!pdfUrl && (
              <button
                className="button button-secondary"
                disabled={busy || pdfBusy || editing || saving}
                onClick={() => void preparePdf()}
              >
                {pdfBusy ? "Preparazione PDF…" : "Prepara PDF"}
              </button>
            )}
            {pdfBusy && (
              <button
                className="text-button"
                onClick={() => pdfController.current?.abort()}
              >
                Annulla PDF
              </button>
            )}
          </div>
          {pdfBusy && (
            <div
              id="pdf-progress"
              tabIndex={-1}
              className="progress-card"
              role="status"
            >
              <strong>Preparazione del PDF sul dispositivo…</strong>
              <progress aria-label="Creazione PDF" />
              <p>Appena pronto troverai qui il pulsante Scarica PDF.</p>
            </div>
          )}
          {pdfUrl && (
            <div className="pdf-actions">
              <a
                id="pdf-download"
                className="button"
                href={pdfUrl}
                download={`${filename}.pdf`}
              >
                Scarica PDF
              </a>
              <a
                className="text-button"
                href={pdfUrl}
                target="_blank"
                rel="noopener noreferrer"
              >
                Apri PDF
              </a>
            </div>
          )}
          {editing ? (
            <div className="notes-editor">
              <label>
                Appunti in Markdown
                <textarea
                  value={draft}
                  onChange={(e) => setDraft(e.target.value)}
                  maxLength={1_000_000}
                />
              </label>
              <p className="local-note">
                Il PDF supporta titoli H1-H3, paragrafi, grassetti, elenchi e
                citazioni. HTML e risorse esterne non vengono caricati.
              </p>
              <button
                className="button"
                disabled={saving || busy}
                onClick={() => void saveDraft()}
              >
                {saving ? "Salvataggio…" : "Salva modifiche sul dispositivo"}
              </button>
            </div>
          ) : (
            <article className="notes-preview">
              <ReactMarkdown
                skipHtml
                components={{
                  a: ({ children }) => <span>{children}</span>,
                  img: () => null,
                }}
              >
                {markdown}
              </ReactMarkdown>
            </article>
          )}
          {Object.entries(data!.transcripts)
            .filter(([, r]) => r.status === "missing")
            .map(([id]) => {
              const chunk = local.manifest.chunks.find((c) => c.id === id)!;
              return (
                <div className="recovery-actions" key={id}>
                  <p className="local-note">
                    Segmento mancante: {timestamp(chunk.startSeconds)} -{" "}
                    {timestamp(chunk.endSeconds)}. Il recupero rigenera gli
                    appunti interessati e sostituisce eventuali modifiche
                    manuali.
                  </p>
                  <button
                    className="text-button"
                    disabled={busy || pdfBusy || saving}
                    onClick={() =>
                      onProcess({ recoverIndex: chunk.index, accurate: true })
                    }
                  >
                    Recupera il segmento mancante con Whisper V3
                  </button>
                </div>
              );
            })}
        </>
      )}
    </section>
  );
}
