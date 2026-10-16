# ProfToPdf

Registrazioni universitarie trasformate in trascrizioni, appunti modificabili e PDF. Produzione: https://proftopdf.velodent.eu.

## Stato verificato

Login/sessione confermati dal proprietario su Samsung S26 Chrome. Anche la correzione MP3 è confermata dal log di produzione: 8.574.676 byte, 35 min 43 s, 13 segmenti, 5,4 s di preparazione, zero errori e nessun motore WASM.

Questa versione collega trascrizione Groq, generazione delle dispense, editor Markdown, esportazione e PDF in Web Worker. Aggiunge barre delle quote giornaliere, distinguendo consumo confermato e prenotazioni. Il nuovo flusso completo va collaudato sul dominio dopo il commit/push del proprietario; il successo della preparazione MP3 non prova ancora la trascrizione di quella lezione o la compatibilità iPad.

Prova integrata reale con contenuto sintetico italiano: 23,51 secondi di audio, una trascrizione, una unità di appunti e un indice; 25 secondi audio conteggiati e 1.763 token. Ripetere la trascrizione restituisce lo stesso risultato da cache senza una seconda chiamata al modello. I precedenti tentativi diagnostici con URL SDK errato restano prudenzialmente prenotati nei contatori; l’URL è corretto e coperto da un test. Nessuna registrazione dell’utente è stata inviata nei controlli automatici.

## Come si usa

1. Accedere, selezionare l’audio e premere **Prepara la lezione**. File fino a 120 MB / 120 minuti; preparazione e segmenti restano sul dispositivo.
2. Nella lezione pronta leggere l’informativa e avviare **Trascrivi e crea la dispensa**. Un solo segmento o una sola unità testuale per richiesta. La pagina deve restare in primo piano; pausa, cambio app e reload conservano le unità confermate in IndexedDB.
3. Le attese di quota avvengono nel browser. Se si lascia aperta la pagina, il lavoro riprende dal momento indicato; altrimenti usare **Riprendi / recupera il risultato**. Gli errori ambigui recuperano la stessa operazione, senza ripetere automaticamente l’inferenza.
4. Se il risultato rimane indisponibile, **Autorizza un nuovo tentativo** permette una nuova chiamata, entro le quote e per massimo tre tentativi per unità. Whisper V3 è un recupero esplicito del segmento, con gli stessi contatori condivisi. Saltare un segmento richiede un’azione esplicita: rimane una lacuna, la dispensa è indicata come parziale e può essere recuperata successivamente.
5. Consultare/scaricare la trascrizione con tempi; leggere gli appunti, modificarli e salvarli localmente. **Prepara PDF** genera il file sul dispositivo, poi **Scarica PDF** o **Apri PDF** ne permettono il salvataggio/condivisione. La seconda azione esplicita facilita Safari. L’anteprima PDF è facoltativa; quella Markdown rimane disponibile.

Il PDF supporta H1-H3, paragrafi, grassetti, elenchi numerati/puntati e citazioni. Font Noto Sans locali con licenza OFL inclusa, accenti e greco, testo selezionabile, sommario, glossario, margini A4 e numerazione. LaTeX, HTML e risorse remote non vengono interpretati; un simbolo assente dal font produce un errore esplicito, senza sostituzioni silenziose. Modifiche Markdown fino a 2 MB. Per evitare sovrapposizioni del renderer inizialmente provato, il PDF usa **PDF-LIB + fontkit** con impaginazione misurata in un worker, al posto di react-pdf. Non richiede API esterne.

## Audio, richieste e ripresa

- WAV PCM: frame e header autonomo, senza ricodifica. MP3 standard: parser MPEG Layer III TypeScript, letture da 256 KiB, CBR/VBR, MPEG-1/2/2.5, CRC, ID3/APE, nuovo header Info e preroll del bit reservoir. Nessun download FFmpeg per MP3 standard.
- Altri formati: FFmpeg.wasm single thread, input Blob/File via WORKERFS, remux AAC/M4A oppure PCM mono 16 kHz (anche per FLAC). Per un profilo AAC non verificabile o vecchi segmenti FLAC, l’interfaccia richiede l’originale e prepara una versione WAV compatibile. L’invalidazione dei dati derivati avviene solo dopo la verifica dell’hash originale.
- Segmenti sotto 3.200.000 byte, corpo HTTP audio binario sotto tale soglia: il file originale non attraversa Vercel. Durata massima del segmento 480 s. Hash, contenitore e durata sono verificati anche sul server; M4A AAC-LC tramite configurazione codec e tabelle campioni, MP3 tramite frame e WAV tramite dati PCM. Il solo totale dichiarato in STREAMINFO FLAC non viene accettato come prova: serve normalizzazione locale. Durata/MIME dichiarati dal client non determinano la quota.
- `prebuild` copia il wrapper/core FFmpeg ufficiale in public/ffmpeg e compila il worker PDF in public/pdf. Entrambe le cartelle generate sono ignorate. Font, licenza, sorgenti e script devono invece essere inclusi nel commit. Nessun download di font durante il build; `scripts/fetch-pdf-fonts.mjs` serve solo per ricrearli dal repository ufficiale.
- Asset FFmpeg versionati e cache immutable; WASM con `application/wasm`. HEAD controlla HTTP/MIME senza scaricare il core due volte. Watchdog: import 30 s, core 180 s, analisi 100 s, segmento 190 s; pausa/annullamento terminano il worker. PDF: worker terminabile, timeout 120 s. Il worker PDF viene rivalidato in cache a ogni utilizzo, così un nuovo deploy non lascia una copia vecchia.
- Nel core FFmpeg 0.12.10 `ffprobe` lascia `-1` sia su successo sia su errore. Si accetta solo JSON nuovo con traccia, durata valida e assenza di stderr significativo. La riga CLI esatta `Aborted()` è distinta dai veri abort; codici nonzero ed errori restano rifiutati.
- IndexedDB conserva Blob, trascrizioni, unità di appunti e documento; scritture di elaborazione e salvataggio editor verificate con lease atomico tra tab. L’audio in memoria è limitato al segmento corrente. Per audio mancante serve l’originale; il testo già confermato può essere ripreso senza reinviarlo.
- Il checkpoint JSON attuale contiene metadati audio, non Blob, trascrizione o appunti. Per il testo usare gli export TXT e Markdown. Conservare sempre l’originale e gli export: il browser può liberare lo storage. Logout non cancella l’archivio locale, che appartiene al browser.

## Quote e sicurezza

- Groq Free: `whisper-large-v3-turbo`, recupero `whisper-large-v3`, appunti `openai/gpt-oss-120b` (20B configurabile). Nessun fallback a pagamento o Gemini. SDK senza retry impliciti; timeout upstream 90 s.
- Finestre mobili condivise: STT 6.600 s/ora, 27.000 s/24 h, 15 richieste/minuto e 1.500/24 h; LLM 6.000 token/minuto, 160.000/24 h, 20 richieste/minuto e 800/24 h. Il costo audio include un piccolo margine e un minimo di 10 s. Sovrapposizioni e nuovi tentativi consumano quota.
- La barra giornaliera mostra **usato** e **prenotato** su 24 ore; le prenotazioni sono tratteggiate. Il reset è progressivo, non a mezzanotte. Chiamate effettuate fuori dall’app non sono visibili nei contatori; un 429 del provider imposta un’attesa condivisa.
- Il server prenota atomicamente con Lua e Redis TIME prima dell’inferenza. Per il testo conta un limite superiore prudente: byte UTF-8 di prompt, schema, testo e metadati, più framing e output massimo incluso ragionamento. Nessuna stima caratteri/4. Riconciliazione con `usage`; timeout/errori ambigui mantengono la prenotazione. Redis indisponibile blocca nuove inferenze.
- Un’operazione idempotente può avviare una sola chiamata upstream. Cache privata con proprietario sessione e fingerprint, TTL 15 min, massimo 500 risultati da 48 KB (meno di 24 MB di payload). Cache piena o risposta persa oltre il TTL non danno garanzia exactly-once: il nuovo tentativo richiede un’azione esplicita. Nessun audio in Redis.
- Sessione `__Host-proftopdf-session`, Secure/HttpOnly/SameSite Strict, durata assoluta 8 h, ID casuale firmato HMAC e record Redis revocabile. Login con confronto costante e limiti IP HMAC/globali. Tutte le mutazioni IA verificano Origin esatta e CSRF; body limitato realmente anche se Content-Length è falso. Rate limit aggiuntivo sulle route.
- Trascrizioni assemblate in ordine; deduplicazione solo sulle zone sovrapposte. Qualità sospetta conservata e segnalata. Appunti strutturati con riferimenti ai segmenti, copertura verificata, incertezze e indice ordinato; output troncati, vuoti o con riferimenti inventati non diventano definitivi.
- Audio/testo sono inviati a Groq soltanto avviando l’elaborazione. Testo/PDF restano localmente, salvo cache server breve. Nessuna promessa di cancellazione lato provider: vedere [Groq Your Data](https://console.groq.com/docs/your-data). Eliminare una lezione cancella i dati locali e tenta la pulizia della cache della sessione; se il server è indisponibile, la cache scade entro 15 min. I contatori di consumo restano.

Restare su Vercel Hobby, Groq Free e Upstash Free senza carta/upgrade. Controllare anche i dashboard del provider: CPU/banda Vercel e comandi Redis mensili non sono misurati completamente dalle barre dell’app. Con i limiti orari prudenziali una lezione di due ore può richiedere un’attesa di circa un’ora per STT; anche gli appunti possono richiedere attese lunghe.

## Diagnostica mobile

**Scarica log diagnostico** è disponibile durante/dopo il lavoro e dopo reload. Il JSON include revisione client, dispositivo/browser, tentativo, orari, tempi, lettore scelto, avanzamento, dimensioni/confini, scritture locali, operazioni IA, attese, codici HTTP/errori e stato PDF. Gli eventi compaiono anche nella console con prefisso `[ProfToPdf audio]`; il server registra soltanto codici tecnici del provider.

Non vengono registrati audio, trascrizioni, titoli/nomi file, password o cookie. Nessun upload automatico del log. Ultime 5 lezioni, 200 eventi / circa 96.000 caratteri per lezione; gli eventi rimossi sono conteggiati. Persistenza tramite localStorage, fallback in memoria (`persistent: false`) se non disponibile. Dopo crash/reload, scaricare il log **prima** di riprovare. Il log non è un checkpoint. Vercel `/api/session` registra il login, non la segmentazione locale.

## Configurazione e deploy

Node.js **22.x**, Next.js 16.4.2, React 19.3.1. Credenziali già configurate: non sovrascrivere `.env` o variabili Vercel. Per nuovi ambienti usare [config/environment.example](config/environment.example), privo di segreti; ogni `.env`, anche `.env.example`, è ignorato. `APP_ORIGIN` deve essere l’origine HTTPS esatta; `AI_ENABLED=true` solo dopo verifica dei piani/chiavi. La configurazione iniziale rimane disabilitata per default. Nessuna nuova credenziale richiesta da queste fasi.

Vercel: install **`npm ci`**, build **`npm run build`**, Node 22.x e **Fluid Compute attivo**; route IA Node con maxDuration 120 s, entro Hobby con Fluid. Non impostare install con `--omit=dev`: esbuild serve al prebuild del worker. Nessun vercel.json necessario. Gli asset PDF vengono rigenerati dal sorgente nel deploy.

Workflow: controlli/build locali → **commit/push soltanto dal proprietario** → deploy Vercel → collaudo sul dominio reale. Nessun comando Git, server/browser localhost o pubblicazione automatica da parte dell’agente. Conservate le esclusioni Documenti/, docs/ e credenziali. I report locali sono in docs/; le istruzioni di deploy sono in questo file.

## Verifiche ripetibili

Chiusura sviluppo del 16/10/2026: **39/39 test automatici**, TypeScript/configurazione/controllo credenziali e build di produzione superati. Verifica contenitori con toni sintetici WAV/MP3/M4A superata; FLAC non normalizzato rifiutato con il codice previsto. Il bundle PDF effettivo produce un campione di **12 pagine**, 120 voci di elenco, greco/accenti e zero violazioni dei margini; testo estratto e PNG ispezionati. Queste verifiche locali e la prova API sintetica descritta sopra non sostituiscono il collaudo del nuovo flusso su dispositivi reali dopo il deploy.

```text
npm ci
npm run check
npm test
npm run build
npm run verify:audio-validation
npm run verify:pdf
```

In PowerShell usare `npm.cmd` se `npm.ps1` è bloccato. `check` esegue TypeScript, configurazione e ricerca di credenziali note in sorgenti/bundle, controllando l’indice senza comandi Git. `verify:audio-validation` richiede FFmpeg nativo e genera solo toni temporanei WAV/MP3/M4A/FLAC. `verify:pdf` esegue il bundle reale del worker con documento sintetico e font locali, senza browser/server/rete; salva docs/pdf-qa/ProfToPdf-collaudo.pdf. Per margini/testo: `python scripts/inspect-pdf.py` richiede Poppler (`pdftotext`). Il campione lungo è stato anche renderizzato in PNG e ispezionato.

`verify:processing` richiede docs/synthetic-lecture.wav, una voce italiana sintetica breve preparata appositamente; usa Redis reale e **consuma quota Groq** con una trascrizione, una unità di appunti e un indice, più un replay da cache. Non eseguirlo ripetutamente senza necessità. Altri controlli già disponibili: verify:infra, verify:quotas, verify:auth, verify:audio-assets, verify:audio-core e verify:mp3; le rispettive chiamate reali restano distinte dai test simulati.

## Collaudo dopo il push

1. Verificare login/sessione sul dominio, barre delle quote e nuova sezione nella lezione MP3 già preparata. Nessun reinvio necessario per i segmenti ancora presenti in IndexedDB.
2. Provare prima una breve registrazione parlata, poi la lezione reale da 35 minuti. Avviare trascrizione/appunti, osservare quote e attese, scaricare il log anche in caso di successo.
3. Durante trascrizione/appunti: pausa, reload, stesso job e ripresa. Le unità salvate non devono essere reinviate. Cambiare app mette in pausa; in due tab il lease impedisce doppie elaborazioni.
4. Controllare trascrizione, concetti, capitoli, sommario, glossario e passaggi incerti. Modificare Markdown, salvare, preparare/scaricare/aprire il PDF; controllare accenti, grassetti, elenchi e pagine finali.
5. Provare M4A/AAC e recupero WAV se richiesto; iPad Safari, Android Chrome, poi file da 60/120 minuti e 20-90 MB. Queste prove mobili lunghe e la qualità su lezioni universitarie umanistiche/tecniche restano aperte: test sintetici e build non le sostituiscono.

Il piano operativo locale piano_ProfToPdf.md contiene lo stato e le evidenze delle fasi; rimane escluso dal repository.
