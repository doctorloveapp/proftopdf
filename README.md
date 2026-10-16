# ProfToPdf

Lezioni universitarie trasformate in dispense ordinate. Dominio di produzione: https://proftopdf.velodent.eu.

## Stato

Il deploy iniziale è stato verificato dal proprietario. Questa versione implementa le Fasi 2 e 3: login con sessione protetta, quote atomiche Upstash, selezione audio mobile/drag-and-drop, segmentazione locale, archivio IndexedDB e ripresa dei job. Trascrizione e generazione PDF saranno collegate nelle fasi successive: la preparazione attuale non invia audio alle API IA.

Modelli predisposti: **whisper-large-v3-turbo** e **openai/gpt-oss-120b**, già verificato per strict output. I report sanificati rimangono in docs/, cartella esclusa dal repository per scelta dell'utente; le istruzioni necessarie alla pubblicazione sono in questo README.

## Autenticazione e quote

- Cookie `__Host-proftopdf-session`: Secure, HttpOnly, SameSite=Strict, senza Domain, durata assoluta 8 ore. Identificativo casuale firmato con HMAC; record revocabile in Redis. Cambiare password o SESSION_SECRET invalida le firme precedenti.
- Login POST con origine esatta, body massimo 2 KB, confronto della password in tempo costante e rate limit atomico: 10 tentativi per IP in 15 minuti e 100 globali. IP conservato soltanto come HMAC. Logout DELETE con CSRF e revoca server; GET ripristina la sessione.
- `/api/quota` è autenticata e non memorizzabile in cache; massimo 10 aggiornamenti/minuto per sessione. Non esiste una route pubblica che prenota costi scelti dal client.
- Prenotazione interna atomica su finestre mobili, orologio Redis, idempotenza e riconciliazione dei consumi. I costi dovranno essere verificati sul server quando saranno introdotte le route IA. Prenotazioni ambigue restano conteggiate; Redis indisponibile ferma le operazioni protette. Timeout Redis per richiesta 5 s, retry impliciti disabilitati.
- Cache privata dei risultati predisposta per le successive route IA: proprietario e fingerprint verificati, scadenza 15 minuti, massimo 500 risultati da 48 KB ciascuno (meno di 24 MB di payload). Nessun audio conservato in Redis.
- Limiti prudenti: STT 6.600 s/ora, 27.000 s/24 ore, 15 richieste/minuto, 1.500/24 ore; LLM 6.000 token/minuto, 160.000/24 ore, 20 richieste/minuto, 800/24 ore. Quote condivise nell'app, senza fallback a pagamento.

## Audio e persistenza

- File fino a 120 MB / 120 minuti. SHA-256 incrementale identifica la registrazione originale quando si riprende un job; nessuna decodifica completa in RAM.
- WAV PCM: lettura dei frame e nuovo header per ogni segmento, senza ricodifica. Altri formati: FFmpeg.wasm single thread in Web Worker, input File/Blob via WORKERFS; remux per AAC/M4A, MP3 e FLAC, normalizzazione mono 16 kHz per gli altri codec. Segmenti sempre controllati sotto 3.200.000 byte, con sovrapposizione ai confini.
- Il worker ufficiale viene servito come ESM locale, evitando il problema di risoluzione degli URL dinamici di Turbopack. `prebuild` copia i pacchetti installati in public/ffmpeg/, esclusa da Git. Percorsi versionati e cache immutable evitano download ripetuti del core, circa 32 MB al primo utilizzo dei formati compressi.
- Salvataggio atomico di segmento Blob e checkpoint in IndexedDB; lease per impedire scritture concorrenti da più tab. Pausa/annullamento, cambio app, reload e riconoscimento dei segmenti mancanti. Per riprendere serve riselezionare l'audio originale; il checkpoint JSON esportabile contiene metadati, non i Blob audio né credenziali.
- L'archivio appartiene al browser, non a singoli account: logout non elimina i dati locali. Sono disponibili eliminazione esplicita e import/export del checkpoint. Il browser può liberare lo storage: conservare sempre la registrazione originale.
- In questo passaggio WAV, interruzione/ripresa e transazioni IndexedDB sono verificati con test automatizzati. Compatibilità reale del worker, M4A/AAC lunghi, picker Safari e memoria iOS restano da collaudare sul dominio dopo push del proprietario.

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
npm run verify:quotas
npm run verify:auth
npm run assets:generate
```

In PowerShell usare `npm.cmd` se `npm.ps1` è bloccato dalla policy. `verify:infra` contatta Groq con una piccola richiesta LLM sintetica; `verify:quotas` prova concorrenza/idempotenza su chiavi Redis diagnostiche poi cancellate; `verify:auth` invoca direttamente le route con Redis reale, senza server/browser locale e senza chiamate IA. Quest'ultimo conteggia due tentativi reali nel rate limit globale di login, conservati per 15 minuti. Non stampa credenziali o cookie. `assets:generate` rigenera i derivati del logo senza modificare il sorgente.

Workflow concordato: scrittura codice → controlli/build locali → **commit e push eseguiti soltanto dal proprietario** → deploy automatico Vercel → collaudo sul dominio HTTPS reale. Nessun browser o server di preview locale viene usato. L'agente non esegue alcun comando Git, nemmeno di sola lettura.

`.gitignore` protegge credenziali, Documenti/, docs/, dipendenze, build e asset FFmpeg generati. `check:repository` controlla eventuali file privati già tracciati senza invocare Git e cerca credenziali note nei sorgenti e nel bundle client. Non occorrono modifiche alle variabili Vercel già presenti. Node 22.x, install `npm ci`, build `npm run build` (il prebuild è automatico).

## Collaudo dopo il prossimo push dell'utente

Verifiche di questa versione: **build riuscita, check superati e 20 test passati**. Autenticazione e quote verificate con Redis reale, zero chiamate Groq in questi controlli. Asset worker/WASM e lockfile verificati; la prova in browser reale resta il prossimo passaggio.

1. Aprire https://proftopdf.velodent.eu: password errata rifiutata, password corretta accettata, sessione conservata dopo reload. Il login è previsto sul dominio APP_ORIGIN, non sulle URL di preview.
2. Provare prima un WAV e un M4A brevi: selezione dal dispositivo, preparazione e segmenti salvati. Per M4A attendere il primo download del motore; non deve esserci upload dell'audio nei log di rete.
3. Mettere in pausa, ricaricare, riselezionare la stessa registrazione e riprendere. Un file diverso deve essere rifiutato. Cambiare app deve mettere in pausa la preparazione.
4. Aprire la stessa lezione in due tab: il lease deve impedire la seconda preparazione e l'eliminazione durante il lavoro. Provare annullamento, checkpoint export/import e cancellazione locale.
5. Controllare quote, logout e nuovo login. Le registrazioni locali rimangono disponibili; l'accesso alle quote senza sessione restituisce 401.
6. Ripetere su iPad Safari e Android Chrome, poi con M4A/AAC reali da 60/120 minuti e 20–90 MB. La build non prova la memoria o la sospensione dei browser mobili.

## Struttura

- `src/app`: studio, layout, metadati, CSS e route session/quota.
- `src/components`, `src/hooks`: login, archivio mobile e gestione preparazione.
- `src/lib/audio`, `src/lib/pipeline`, `src/lib/storage`: segmentazione, hash, job e IndexedDB.
- `src/lib/shared`: modelli AudioManifest, TranscriptSegment, LectureDocument, QuotaState e ProcessingJob.
- `src/lib/server`: autenticazione, quote Lua, configurazione validata e client Groq/Redis.
- `public`: asset ottimizzati, favicon e manifest.
- `scripts`: ricognizione live, generazione asset e controllo repository.
- `tests/unit`: sicurezza, WAV, interruzione/ripresa e transazioni IndexedDB.
- `docs`: report locali di fattibilità, autenticazione e quote (non pubblicati).

Il piano operativo locale piano_ProfToPdf.md contiene lo stato delle fasi; resta escluso dal repository secondo la configurazione già presente.
