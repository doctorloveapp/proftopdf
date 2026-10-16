import Link from "next/link";

export default function NotFound() {
  return (
    <main
      className="site-shell"
      style={{ paddingTop: "15vh", paddingBottom: "15vh" }}
    >
      <p className="eyebrow">PROFTOPDF / 404</p>
      <h1>
        Questa pagina
        <br />
        non è qui.
      </h1>
      <p className="hero-description">Torna al tuo punto di partenza.</p>
      <Link className="primary-link" href="/">
        Vai alla pagina iniziale
      </Link>
    </main>
  );
}
