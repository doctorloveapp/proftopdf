# ProfToPdf

Lezioni universitarie trasformate in dispense ordinate. Dominio di produzione: https://proftopdf.velodent.eu.

## Stato

Il deploy iniziale e l’autenticazione/sessione su Samsung S26 Chrome sono stati verificati dal proprietario. Questa versione implementa le Fasi 2 e 3: login con sessione protetta, quote atomiche Upstash, selezione audio mobile/drag-and-drop, segmentazione locale, archivio IndexedDB e ripresa dei job. Include la correzione del blocco MP3 e il log diagnostico scaricabile, da ricollaudare sul dispositivo dopo il prossimo deploy. Trascrizione e generazione PDF saranno collegate nelle fasi successive: la preparazione attuale non invia audio alle API IA.

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
- WAV PCM: lettura dei frame e nuovo header per ogni segmento, senza ricodifica. MP3 standard: scansione MPEG Layer III in TypeScript, senza scaricare o invocare FFmpeg, con letture da 256 KiB e indice compatto. Supporta CBR/VBR, MPEG-1/2/2.5, CRC e tag ID3/APE; esclude i metadati globali Xing/VBRI e genera un header Info per la durata di ciascun segmento. I confini includono preroll per il bit reservoir e sovrapposizione: la durata è quella dei frame codificati, incluso l’eventuale padding del codec. File troncati, cambi di formato e MP3 free-format producono errori espliciti, senza avviare automaticamente il motore pesante.
- Altri formati: FFmpeg.wasm single thread in Web Worker, input File/Blob via WORKERFS; remux per AAC/M4A e FLAC, normalizzazione mono 16 kHz per gli altri codec. Segmenti sempre controllati sotto 3.200.000 byte, con sovrapposizione ai confini.
- Il worker ufficiale viene servito come ESM locale, evitando il problema di risoluzione degli URL dinamici di Turbopack. `prebuild` copia i pacchetti installati in public/ffmpeg/, esclusa da Git. Percorsi versionati e cache immutable evitano download ripetuti del core, circa 32 MB al primo utilizzo dei formati che richiedono FFmpeg. Il WASM ha header esplicito `application/wasm`; preflight HEAD verifica HTTP/MIME senza scaricarlo due volte. Watchdog esterni: import 30 s, caricamento core 180 s, analisi 100 s e segmento 190 s; pausa/annullamento terminano il worker.
- Correzione `ffprobe`: nel core 0.12.10 il valore `-1` resta presente sia dopo una lettura valida sia dopo un errore, riprodotto con audio sintetico. Ora si accetta quel valore solo con JSON appena generato, traccia audio, durata positiva finita e nessun errore stderr; ogni analisi usa un file di output distinto. I veri errori restano rifiutati.
- Salvataggio atomico di segmento Blob e checkpoint in IndexedDB; lease per impedire scritture concorrenti da più tab. Pausa/annullamento, cambio app, reload e riconoscimento dei segmenti mancanti. Per riprendere serve riselezionare l'audio originale; il checkpoint JSON esportabile contiene metadati, non i Blob audio né credenziali.
- L'archivio appartiene al browser, non a singoli account: logout non elimina i dati locali. Sono disponibili eliminazione esplicita e import/export del checkpoint. Il browser può liberare lo storage: conservare sempre la registrazione originale.
- WAV, MP3, interruzione/ripresa e transazioni IndexedDB sono verificati con test automatizzati. MP3 sintetici reali sono stati segmentati e decodificati con FFmpeg nativo indipendente. Compatibilità reale del worker, il file MP3 segnalato dall’utente, M4A/AAC lunghi, picker Safari e memoria iOS restano da collaudare sul dominio dopo push del proprietario.

## Log diagnostico mobile

Nella scheda della lezione premere **Scarica log diagnostico**, disponibile anche durante la preparazione e dopo un errore. Si ottiene `ProfToPdf-log-xxxxxxxx.json`: revisione dell’app, dispositivo/browser, orari, identificativo del tentativo, tempi trascorsi, lettore scelto, avanzamento hash/scansione, confini/dimensioni dei segmenti, scritture IndexedDB, pause e codici d’errore. Per FFmpeg include risposta HTTP/MIME degli asset, inizio/fine di ogni operazione, uscita di ffprobe ed errori tecnici stderr limitati. Gli stessi eventi compaiono nella console con prefisso `[ProfToPdf audio]`.

Il log resta sul dispositivo, senza upload automatico; non raccoglie audio, trascrizioni, nomi/titoli della lezione, fingerprint, password o cookie. Conserva al massimo 5 lezioni, 200 eventi e circa 96.000 caratteri per lezione, segnalando gli eventi più vecchi rimossi. Sopravvive al reload tramite localStorage; se lo storage non è disponibile, resta esportabile dalla pagina corrente con `persistent: false`. Eliminare la lezione elimina anche il suo registro quando lo storage è disponibile. Il log non è un checkpoint e non va importato come tale.

Se l’operazione si blocca, scaricare il log prima di chiudere la pagina; dopo un crash/reload, riselezionare la lezione e scaricarlo **prima** di riprovare. Condividere quel JSON con l’agente, insieme all’esito visibile. I log Vercel di `/api/session` descrivono il login (401 = richiesta non autorizzata); non registrano la segmentazione locale dell’audio.

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
npm run verify:audio-assets
npm run verify:audio-core
npm run verify:mp3
npm run assets:generate
```

In PowerShell usare `npm.cmd` se `npm.ps1` è bloccato dalla policy. `verify:infra` contatta Groq con una piccola richiesta LLM sintetica; `verify:quotas` prova concorrenza/idempotenza su chiavi Redis diagnostiche poi cancellate; `verify:auth` invoca direttamente le route con Redis reale, senza server/browser locale e senza chiamate IA. Quest'ultimo conteggia due tentativi reali nel rate limit globale di login, conservati per 15 minuti. Non stampa credenziali o cookie. `assets:generate` rigenera i derivati del logo senza modificare il sorgente.

`verify:audio-assets` esegue solo HEAD sul dominio di produzione, senza scaricare il core. `verify:audio-core` riproduce il caso valido/non valido con il core WASM installato e audio sintetico, senza browser o rete. `verify:mp3` è opzionale e richiede FFmpeg/ffprobe nativi nel PATH: genera toni sintetici CBR/VBR/MPEG-2, controlla durata/dimensioni e decodifica ogni segmento; rimuove soltanto i file temporanei creati. Nessuno di questi controlli consuma quote IA.

Workflow concordato: scrittura codice → controlli/build locali → **commit e push eseguiti soltanto dal proprietario** → deploy automatico Vercel → collaudo sul dominio HTTPS reale. Nessun browser o server di preview locale viene usato. L’agente non esegue alcun comando Git, nemmeno di sola lettura.

`.gitignore` protegge credenziali, Documenti/, docs/, dipendenze, build e asset FFmpeg generati. `check:repository` controlla eventuali file privati già tracciati senza invocare Git e cerca credenziali note nei sorgenti e nel bundle client. Non occorrono modifiche alle variabili Vercel già presenti. Node 22.x, install `npm ci`, build `npm run build` (il prebuild è automatico).

## Collaudo dopo il prossimo push dell'utente

Verifiche audio: **build di produzione riuscita, check superati e 27 test passati**, incluso il percorso MP3 senza Worker/window e la ripresa da IndexedDB. Controllo del core WASM passato: WAV e AAC/M4A validi accettati, audio non valido rifiutato, tutti con uscita `-1` di ffprobe. La riga esatta `Aborted()` dell’uscita CLI Emscripten viene registrata separatamente, mantenendo i controlli sui veri errori e sui codici nonzero. Tre MP3 sintetici reali CBR/VBR/MPEG-2 da 310 secondi decodificati senza errori; CBR da 8.682.101 byte, scansione circa 480 ms su questo PC, 3 segmenti. I tempi non misurano il Samsung. HEAD degli asset già in produzione: HTTP 200, JavaScript corretto e `application/wasm`; il MIME non è risultato la causa del problema. Autenticazione e quote erano già verificate con Redis reale; nessuna chiamata IA per questa correzione.

1. Aprire https://proftopdf.velodent.eu: password errata rifiutata, password corretta accettata, sessione conservata dopo reload. Il login è previsto sul dominio APP_ORIGIN, non sulle URL di preview.
2. Riprovare **lo stesso MP3 reale da 8,6 MB** su Samsung S26 Chrome: deve scegliere il lettore MP3 leggero, completare la preparazione e salvare i segmenti senza richieste `/ffmpeg/`. Scaricare il log anche in caso di successo; deve contenere revisione `audio-2026-10-16-v1`, `mp3-js`, `mp3.scan.complete`, `chunk.saved` e `preparation.complete`. In caso di errore, condividere il JSON scaricato.
3. Mettere in pausa, ricaricare, riselezionare la stessa registrazione e riprendere. Un file diverso deve essere rifiutato. Cambiare app deve mettere in pausa la preparazione.
4. Aprire la stessa lezione in due tab: il lease deve impedire la seconda preparazione e l'eliminazione durante il lavoro. Provare annullamento, checkpoint export/import e cancellazione locale.
5. Controllare quote, logout e nuovo login. Le registrazioni locali rimangono disponibili; l'accesso alle quote senza sessione restituisce 401.
6. Provare WAV e M4A brevi, poi MP3/M4A/AAC reali da 60/120 minuti e 20–90 MB su iPad Safari e Android Chrome. Per M4A attendere il primo download del motore: il log deve mostrare analisi valida anche se il core restituisce `-1`. Non deve esserci upload dell’audio nei log di rete. La build non prova la memoria o la sospensione dei browser mobili.

## Struttura

- `src/app`: studio, layout, metadati, CSS e route session/quota.
- `src/components`, `src/hooks`: login, archivio mobile e gestione preparazione.
- `src/lib/audio`, `src/lib/pipeline`, `src/lib/storage`: segmentazione, hash, job e IndexedDB.
- `src/lib/shared`: modelli AudioManifest, TranscriptSegment, LectureDocument, QuotaState e ProcessingJob.
- `src/lib/server`: autenticazione, quote Lua, configurazione validata e client Groq/Redis.
- `public`: asset ottimizzati, favicon e manifest.
- `scripts`: ricognizione live, generazione asset e controllo repository.
- `tests/unit`: sicurezza, WAV/MP3, diagnostica, timeout, interruzione/ripresa e transazioni IndexedDB.
- `docs`: report locali di fattibilità, autenticazione e quote (non pubblicati).

Il piano operativo locale piano_ProfToPdf.md contiene lo stato delle fasi; resta escluso dal repository secondo la configurazione già presente.
