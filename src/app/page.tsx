import Image from 'next/image';

function ArrowIcon() {
  return <svg aria-hidden="true" width="20" height="20" viewBox="0 0 24 24" fill="none"><path d="M5 12h14m-6-6 6 6-6 6" stroke="currentColor" strokeWidth="1.7" strokeLinecap="round" strokeLinejoin="round" /></svg>;
}

const steps = [
  { number: '01', title: 'La tua registrazione', text: 'Parti dal file audio della lezione, direttamente dal tuo dispositivo.' },
  { number: '02', title: 'Un filo logico', text: 'Capitoli, definizioni e concetti chiave per ritrovare quello che conta.' },
  { number: '03', title: 'Pronti da studiare', text: 'Una dispensa ordinata da rileggere, annotare e portare con te.' },
];

export default function Home() {
  return (
    <div className="site-shell">
      <a className="skip-link" href="#contenuto">Vai al contenuto</a>
      <header className="site-header">
        <a href="/" aria-label="ProfToPdf, pagina iniziale" className="brand">
          <Image src="/logo-navbar.webp" alt="ProfToPdf" width={236} height={42} priority unoptimized />
        </a>
        <a className="header-link" href="#come-funziona">Come funziona <span aria-hidden="true">↗</span></a>
      </header>

      <main id="contenuto">
        <section className="hero" aria-labelledby="hero-title">
          <div className="hero-copy">
            <div className="eyebrow"><span className="small-line" /> MENO RIORDINO. PIÙ STUDIO.</div>
            <h1 id="hero-title">La lezione passa.<br />Gli appunti <span>restano.</span></h1>
            <p className="hero-description">Dall&apos;audio della tua lezione a una dispensa chiara. Un posto per raccogliere i concetti, seguire il ragionamento e tornare a studiare.</p>
            <div className="launch-card" role="status">
              <span className="status-dot" aria-hidden="true" />
              <div><strong>Stiamo preparando il tuo spazio di studio.</strong><p>Il caricamento delle lezioni sarà disponibile nei prossimi aggiornamenti.</p></div>
            </div>
            <a href="#come-funziona" className="primary-link">Scopri il percorso <ArrowIcon /></a>
            <div className="hero-footnote"><span aria-hidden="true">✦</span> Pensato per le lezioni universitarie. E per chi le segue.</div>
          </div>

          <div className="document-scene" aria-label="Esempio illustrativo di una dispensa organizzata">
            <div className="audio-tag"><span className="wave" aria-hidden="true"><i /><i /><i /><i /><i /><i /><i /></span><div><strong>Una lezione, tanti concetti.</strong><span>Ritrovali in un unico documento.</span></div></div>
            <article className="sample-document">
              <div className="document-top"><span>PROFTOPDF / DISPENSA</span><span>01</span></div>
              <div className="document-rule" />
              <p className="document-subtitle">ESEMPIO DI IMPAGINAZIONE</p>
              <h2>Le idee prendono<br />una forma chiara.</h2>
              <p className="document-intro">Il contenuto della lezione, organizzato per accompagnarti nel ripasso.</p>
              <div className="contents"><span className="section-label">IN QUESTA DISPENSA</span><div><span>01 &nbsp; I concetti fondamentali</span><span>3</span></div><div><span>02 &nbsp; Definizioni ed esempi</span><span>6</span></div><div><span>03 &nbsp; Le parole da ricordare</span><span>9</span></div></div>
              <div className="sample-section"><span className="chapter-number">01</span><h3>I concetti fondamentali</h3></div>
              <p className="sample-paragraph">Un ragionamento diventa più facile da seguire quando <strong>i punti chiave sono riconoscibili</strong> e ogni argomento trova il suo posto.</p>
              <div className="key-box"><span aria-hidden="true">✦</span><div><strong>Da ricordare</strong><p>Un concetto alla volta, con un filo che li collega.</p></div></div>
              <div className="document-bottom"><span>Le tue lezioni, in ordine.</span><span>ProfToPdf</span></div>
            </article>
            <div className="document-caption"><span aria-hidden="true">↳</span> Dal parlato alla pagina.</div>
          </div>
        </section>

        <section className="how-section" id="come-funziona" aria-labelledby="how-title">
          <div className="how-heading"><p className="eyebrow">IL PERCORSO</p><h2 id="how-title">Dalla lezione al ripasso.<br />Con un po&apos; più di ordine.</h2></div>
          <div className="steps">{steps.map((step) => <article key={step.number} className="step"><span className="step-number">{step.number}</span><h3>{step.title}</h3><p>{step.text}</p></article>)}</div>
        </section>
      </main>
      <footer className="site-footer"><span>ProfToPdf</span><p>Più spazio alle idee, meno al riordino.</p><span className="footer-note">In preparazione</span></footer>
    </div>
  );
}
