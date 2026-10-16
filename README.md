# ProfToPdf

Lezioni universitarie trasformate in dispense ordinate. Dominio di produzione: https://proftopdf.velodent.eu.

## Stato

Scaffold iniziale Next.js App Router + React + TypeScript + Tailwind. Homepage responsive con branding originale, icone iOS/Android e manifest. Tipi condivisi e client Groq/Redis server-only predisposti. Upload, autenticazione, rate limiting e PDF saranno implementati nelle fasi successive; nessun endpoint pubblico di inferenza è attivo.

Le verifiche live dell'infrastruttura sono documentate in [docs/feasibility.md](docs/feasibility.md), con elenco esatto dei modelli e report sanificato. Modelli scelti: **whisper-large-v3-turbo** e **openai/gpt-oss-120b**; strict output verificato con una richiesta sintetica.

## Configurazione

Node.js **22.x**. Il file `.env` esistente contiene già le credenziali: non sovrascriverlo. Per nuovi ambienti, partire dal template privo di segreti [config/environment.example](config/environment.example). Ogni `.env` e sua variante è escluso dal repository, compreso `.env.example`.

`APP_ACCESS_PASSWORD` conserva il nome già configurato in Vercel; nessun obbligo di rinominarlo o creare nuove credenziali. `APP_ORIGIN` deve essere una origine HTTPS senza percorso. I segreti vengono letti solo dal server e non sono richiesti durante la generazione della homepage statica.

## Comandi di verifica

```text
npm ci
npm run check
npm test
npm run build
npm run verify:infra
npm run assets:generate
```

In PowerShell usare `npm.cmd` se `npm.ps1` è bloccato dalla policy. `verify:infra` contatta i servizi reali con una piccola richiesta LLM sintetica; gli altri controlli non chiamano le API IA. `assets:generate` rigenera i derivati locali da assets/logo.jpg con Sharp. Non modifica il sorgente.

Workflow concordato: scrittura codice → controlli/build locali → **commit e push eseguiti soltanto dal proprietario** → deploy automatico Vercel → collaudo sul dominio HTTPS reale. Nessun browser o server di preview locale viene usato. L'agente non esegue alcun comando Git, nemmeno di sola lettura.

Vedere [docs/deployment.md](docs/deployment.md) per il primo deploy. `.gitignore` protegge credenziali, Documenti/, dipendenze, build e cache; `check:repository` verifica anche eventuali file privati già tracciati senza invocare Git, e cerca credenziali note nei sorgenti e nel bundle client.

## Struttura

- `src/app`: pagina iniziale, layout, metadati e CSS.
- `src/lib/shared`: modelli AudioManifest, TranscriptSegment, LectureDocument, QuotaState e ProcessingJob.
- `src/lib/server`: configurazione validata e client Groq/Redis.
- `public`: asset ottimizzati, favicon e manifest.
- `scripts`: ricognizione live, generazione asset e controllo repository.
- `tests/unit`: verifiche dei limiti e della configurazione di sicurezza.
- `docs`: evidenze di fattibilità e istruzioni operative.

Il piano operativo locale piano_ProfToPdf.md contiene lo stato delle fasi; resta escluso dal repository secondo la configurazione già presente.

