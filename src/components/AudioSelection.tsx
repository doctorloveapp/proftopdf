"use client";
import { useEffect, useRef, useState } from "react";
import { AUDIO_ACCEPT } from "@/lib/pipeline/prepare-audio";
import { readAudioDuration } from "@/lib/audio/duration";
import AudioPartsList from "./AudioPartsList";
import { audioPicker } from "@/lib/client/audio-picker";
import { AudioProcessingError, type AudioDetails } from "@/lib/audio/errors";

export default function AudioSelection({
  files,
  disabled,
  restoring,
  onChoose,
  onOrder,
  onMetadata,
}: {
  files: File[];
  disabled: boolean;
  restoring: boolean;
  onChoose: (files: File[]) => void;
  onOrder: (files: File[]) => void;
  onMetadata?: (file: File, details: AudioDetails) => void;
}) {
  const picker = useRef<HTMLInputElement>(null);
  const allFilesPicker = useRef<HTMLInputElement>(null);
  const [dragging, setDragging] = useState(false);
  const [pickerBusy, setPickerBusy] = useState(false);
  const [pickerError, setPickerError] = useState("");
  const activePicker = useRef(false);
  const selectionContext = useRef<AudioDetails>({
    picker: "standard",
    directoryMemoryRequested: false,
  });
  function acceptFiles(
    candidates: File[],
    mode: "standard" | "remembering" | "drop",
  ) {
    if (disabled) return;
    selectionContext.current = {
      picker: mode,
      directoryMemoryRequested: mode === "remembering",
    };
    onChoose(candidates);
  }
  const [durationErrors, setDurationErrors] = useState(new Map<File, string>());
  async function openPicker(allFiles = false) {
    if (disabled || activePicker.current) return;
    const native = allFiles ? allFilesPicker.current : picker.current;
    setPickerError("");
    if (!audioPicker.canRememberLocation()) {
      if (native) {
        native.value = "";
        native.click();
      }
      return;
    }
    activePicker.current = true;
    setPickerBusy(true);
    try {
      const selected = await audioPicker.open(allFiles);
      if (selected?.length) acceptFiles(selected, "remembering");
    } catch (error) {
      setPickerError(
        error instanceof AudioProcessingError
          ? error.message
          : "Il browser non ha aperto o letto la selezione con memoria della cartella. Usa il selettore standard qui sotto.",
      );
    } finally {
      activePicker.current = false;
      setPickerBusy(false);
    }
  }
  const [durations, setDurations] = useState<Map<File, number | null>>(
    new Map(),
  );
  const cache = useRef(new Map<File, number | null>());
  useEffect(() => {
    const aborter = new AbortController();
    const wanted = new Set(files);
    for (const file of cache.current.keys())
      if (!wanted.has(file)) cache.current.delete(file);
    setDurationErrors(
      (old) => new Map([...old].filter(([file]) => wanted.has(file))),
    );
    setDurations(new Map(cache.current));
    if (!disabled)
      void (async () => {
        for (const [index, file] of files.entries()) {
          if (aborter.signal.aborted) return;
          if (cache.current.has(file)) continue;
          onMetadata?.(file, selectionContext.current);
          let seconds: number | null = null;
          try {
            seconds = await readAudioDuration(
              file,
              aborter.signal,
              (details) => {
                console.info("[ProfToPdf metadata]", {
                  part: index,
                  ...details,
                });
                onMetadata?.(file, { ...details });
              },
            );
          } catch (error) {
            if (aborter.signal.aborted) return;
            const code =
              error instanceof AudioProcessingError
                ? error.code
                : "AUDIO_METADATA_READ";
            console.warn("[ProfToPdf metadata]", { part: index, code });
            onMetadata?.(file, { code });
            setDurationErrors((old) => new Map(old).set(file, code));
          }
          if (aborter.signal.aborted) return;
          cache.current.set(file, seconds);
          setDurations(new Map(cache.current));
        }
      })();
    return () => aborter.abort();
  }, [files, disabled, onMetadata]);
  return (
    <>
      <div
        className={`drop-zone ${dragging ? "is-dragging" : ""}`}
        onDragOver={(event) => {
          event.preventDefault();
          if (!disabled) setDragging(true);
        }}
        onDragLeave={() => setDragging(false)}
        onDrop={(event) => {
          event.preventDefault();
          setDragging(false);
          if (!disabled && !pickerBusy)
            acceptFiles(Array.from(event.dataTransfer.files), "drop");
        }}
      >
        <span className="upload-symbol" aria-hidden="true">
          ↑
        </span>
        <h3>
          {files.length
            ? `${files.length} ${files.length === 1 ? "registrazione selezionata" : "registrazioni selezionate"}`
            : restoring
              ? "Ritrova gli originali"
              : "La registrazione è qui che inizia."}
        </h3>
        <p>
          {files.length
            ? `${(files.reduce((sum, file) => sum + file.size, 0) / 1e6).toFixed(1)} MB · controlla l’ordine qui sotto`
            : "Scegli uno o più audio dal dispositivo, oppure trascinali qui."}
        </p>
        <button
          id="audio-picker-button"
          className="button"
          type="button"
          disabled={disabled || pickerBusy}
          onClick={() => void openPicker()}
        >
          {files.length
            ? "+ Aggiungi registrazioni"
            : "Scegli la registrazione"}
        </button>
        <span className="format-note">
          M4A, AAC, MP3, WAV, FLAC, Ogg, WebM · fino a 120 MB / 120 min
          complessivi
        </span>
        <input
          ref={picker}
          type="file"
          multiple
          accept={AUDIO_ACCEPT}
          hidden
          onChange={(event) =>
            acceptFiles(Array.from(event.target.files ?? []), "standard")
          }
        />
        <input
          ref={allFilesPicker}
          type="file"
          multiple
          hidden
          aria-label="Seleziona registrazioni da tutti i file"
          onChange={(event) =>
            acceptFiles(Array.from(event.target.files ?? []), "standard")
          }
        />
      </div>
      {pickerError && (
        <div className="feedback" role="alert">
          <p>{pickerError}</p>
          <button
            type="button"
            className="button button-secondary"
            disabled={disabled}
            onClick={() => {
              if (allFilesPicker.current) {
                allFilesPicker.current.value = "";
                allFilesPicker.current.click();
              }
            }}
          >
            Apri selettore standard
          </button>
        </div>
      )}
      <details className="recording-help">
        <summary>Non trovi le registrazioni? Guida per Samsung</summary>
        <div>
          <p>
            Dal selettore apri il menu ☰ e cerca{" "}
            <strong>Memoria interna → Recordings → Voice Recorder</strong>. I
            nomi delle voci possono variare sul telefono.
          </p>
          <p>
            Se vedi soltanto “Recenti” o alcuni audio, prova il pulsante qui
            sotto: permette di sfogliare i file senza il filtro audio.
          </p>
          <button
            className="button button-secondary"
            type="button"
            disabled={disabled || pickerBusy}
            onClick={() => void openPicker(true)}
          >
            Sfoglia tutti i file
          </button>
          <p>
            In alternativa apri <strong>Archivio</strong> sul Samsung, vai nello
            stesso percorso, seleziona le registrazioni e usa{" "}
            <strong>Copia → Download → Copia qui</strong>. Torna in ProfToPdf e
            sceglile da Download: non serve passare da Google Drive.
          </p>
          <a
            href="https://www.samsung.com/it/support/mobile-devices/how-to-record-play-back-and-share-voice-recordings-on-your-samsung-galaxy-phone/"
            target="_blank"
            rel="noreferrer"
          >
            Guida ufficiale Samsung ↗
          </a>
        </div>
      </details>
      {files.length > 0 && (
        <>
          <AudioPartsList
            disabled={disabled}
            items={files.map((file) => ({
              name: file.name,
              lastModified: file.lastModified,
              durationSeconds: durations.get(file) ?? undefined,
              durationPending: !durations.has(file),
              durationErrorCode: durationErrors.get(file),
            }))}
            onMove={(index, direction) => {
              const next = [...files];
              [next[index], next[index + direction]] = [
                next[index + direction],
                next[index],
              ];
              onOrder(next);
            }}
            onRemove={(index) => onOrder(files.filter((_, i) => i !== index))}
          />
          <p className="local-note">
            Ogni nuovo gruppo è ordinato per data, poi per nome, e aggiunto in
            fondo senza cambiare l’ordine già scelto. La data fornita dal
            telefono può cambiare: usa le frecce per correggere la sequenza
            prima di preparare la lezione.
          </p>
        </>
      )}
      {restoring && (
        <p className="local-note">
          Per riprendere, seleziona tutti gli originali nello stesso ordine
          della lezione salvata.
        </p>
      )}
    </>
  );
}
