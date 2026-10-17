"use client";
import { useEffect, useRef, useState } from "react";
import { AUDIO_ACCEPT } from "@/lib/pipeline/prepare-audio";
import { readAudioDuration } from "@/lib/audio/duration";
import AudioPartsList from "./AudioPartsList";

export default function AudioSelection({
  files,
  disabled,
  restoring,
  onChoose,
  onOrder,
}: {
  files: File[];
  disabled: boolean;
  restoring: boolean;
  onChoose: (files: File[]) => void;
  onOrder: (files: File[]) => void;
}) {
  const picker = useRef<HTMLInputElement>(null);
  const [dragging, setDragging] = useState(false);
  const [durations, setDurations] = useState<Map<File, number | null>>(
    new Map(),
  );
  const cache = useRef(new Map<File, number | null>());
  useEffect(() => {
    const aborter = new AbortController();
    const wanted = new Set(files);
    for (const file of cache.current.keys())
      if (!wanted.has(file)) cache.current.delete(file);
    setDurations(new Map(cache.current));
    if (!disabled)
      void (async () => {
        for (const file of files) {
          if (aborter.signal.aborted) return;
          if (cache.current.has(file)) continue;
          let seconds: number | null = null;
          try {
            seconds = await readAudioDuration(file, aborter.signal);
          } catch {}
          if (aborter.signal.aborted) return;
          cache.current.set(file, seconds);
          setDurations(new Map(cache.current));
        }
      })();
    return () => aborter.abort();
  }, [files, disabled]);
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
          if (!disabled) onChoose(Array.from(event.dataTransfer.files));
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
          disabled={disabled}
          onClick={() => {
            if (picker.current) picker.current.value = "";
            picker.current?.click();
          }}
        >
          {files.length ? "Cambia selezione" : "Scegli la registrazione"}
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
          onChange={(event) => onChoose(Array.from(event.target.files ?? []))}
        />
      </div>
      {files.length > 0 && (
        <>
          <AudioPartsList
            disabled={disabled}
            items={files.map((file) => ({
              name: file.name,
              lastModified: file.lastModified,
              durationSeconds: durations.get(file) ?? undefined,
              durationPending: !durations.has(file),
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
            Ordine iniziale per data di modifica, poi per nome. La data fornita
            dal telefono può cambiare: usa le frecce per correggere la sequenza
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
