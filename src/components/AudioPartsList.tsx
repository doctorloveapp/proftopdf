export const audioDurationText = (seconds: number) => {
  const value = Math.round(seconds);
  return `${Math.floor(value / 60)} min ${String(value % 60).padStart(2, "0")} s`;
};
export interface AudioPartView {
  name: string;
  durationSeconds?: number;
  lastModified?: number;
  durationPending?: boolean;
  durationErrorCode?: string;
}
export default function AudioPartsList({
  items,
  disabled = false,
  onMove,
  onRemove,
}: {
  items: AudioPartView[];
  disabled?: boolean;
  onMove?: (index: number, direction: -1 | 1) => void;
  onRemove?: (index: number) => void;
}) {
  if (!items.length) return null;
  const total = items.reduce(
    (sum, item) => sum + (item.durationSeconds ?? 0),
    0,
  );
  const missing = items.filter((item) => !item.durationSeconds).length;
  return (
    <div className="audio-parts">
      <p className="eyebrow">ORDINE DI ASCOLTO</p>
      <ol
        className="audio-part-list"
        aria-label="Spezzoni della lezione in ordine"
      >
        {items.map((item, index) => (
          <li key={index}>
            <span className="audio-part-number" aria-hidden="true">
              {index + 1}
            </span>
            <div className="audio-part-info">
              <strong>{item.name}</strong>
              <span
                title={
                  item.durationErrorCode
                    ? `Diagnostica durata: ${item.durationErrorCode}`
                    : undefined
                }
              >
                {item.durationSeconds
                  ? audioDurationText(item.durationSeconds)
                  : item.durationPending
                    ? "Lettura durata…"
                    : "Durata da verificare durante la preparazione"}
              </span>
              <span>
                {item.lastModified
                  ? new Date(item.lastModified).toLocaleString("it-IT")
                  : "Data non disponibile"}
              </span>
            </div>
            {(onMove || onRemove) && (
              <div className="audio-part-actions">
                {onMove && (
                  <>
                    <button
                      type="button"
                      className="part-control"
                      disabled={disabled || index === 0}
                      aria-label={`Sposta su lo spezzone ${index + 1}`}
                      onClick={() => onMove(index, -1)}
                    >
                      ↑
                    </button>
                    <button
                      type="button"
                      className="part-control"
                      disabled={disabled || index === items.length - 1}
                      aria-label={`Sposta giù lo spezzone ${index + 1}`}
                      onClick={() => onMove(index, 1)}
                    >
                      ↓
                    </button>
                  </>
                )}
                {onRemove && (
                  <button
                    type="button"
                    className="part-control danger"
                    disabled={disabled}
                    aria-label={`Rimuovi lo spezzone ${index + 1}`}
                    onClick={() => onRemove(index)}
                  >
                    ×
                  </button>
                )}
              </div>
            )}
          </li>
        ))}
      </ol>
      <p className="audio-total" role="status">
        Durata {missing ? "rilevata" : "totale"}:{" "}
        <strong>{audioDurationText(total)}</strong>
        {missing > 0 &&
          ` · ${missing} ${missing === 1 ? "spezzone da verificare" : "spezzoni da verificare"}`}
      </p>
    </div>
  );
}
