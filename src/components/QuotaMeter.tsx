import type { QuotaWindow } from "@/lib/shared/types";
export default function QuotaMeter({
  window,
  label,
}: {
  window?: QuotaWindow;
  label: string;
}) {
  if (!window || window.limit <= 0)
    return <p className="local-note">Quota giornaliera non disponibile.</p>;
  const used = Math.min(window.limit, Math.max(0, window.used)),
    reserved = Math.min(window.limit - used, Math.max(0, window.reserved));
  const consumed = ((used + reserved) / window.limit) * 100;
  const format = (value: number) =>
    window.resource === "audio-seconds"
      ? `${(value / 60).toLocaleString("it-IT", { maximumFractionDigits: 1 })} min`
      : `${value.toLocaleString("it-IT")} token`;
  return (
    <div className={`quota-meter ${consumed >= 90 ? "quota-near-limit" : ""}`}>
      <div className="quota-meter-label">
        <span>{Math.round(consumed)}% utilizzato o prenotato</span>
        <span>Ultime 24 ore</span>
      </div>
      <div
        className="quota-track"
        role="meter"
        aria-label={label}
        aria-valuemin={0}
        aria-valuemax={window.limit}
        aria-valuenow={used + reserved}
        aria-valuetext={`${format(used)} utilizzati, ${format(reserved)} prenotati su ${format(window.limit)}`}
      >
        <span
          className="quota-used"
          style={{ width: `${(used / window.limit) * 100}%` }}
        />
        <span
          className="quota-reserved"
          style={{ width: `${(reserved / window.limit) * 100}%` }}
        />
      </div>
      <p className="quota-meter-detail">
        {format(used)} usati su {format(window.limit)}
        {reserved > 0 ? ` · ${format(reserved)} prenotati` : ""}
      </p>
    </div>
  );
}
