# UILink Concorsi Calabria – Web App

Web app per iPhone di **UILink Concorsi Calabria** (UIL Calabria):

- ogni mattina raccoglie i bandi aperti in Calabria da **inPA**, **ConcorsiPubblici.com** e **Concorsando**;
- riconosce gli enti monitorati (vedi `data/fonti.json`);
- mostra i follower di Instagram, TikTok e Facebook;
- crea il testo per i video, modificabile, partendo dai bandi selezionati.

Tutto gratuito: il sito è ospitato su **GitHub Pages** e l'aggiornamento gira con **GitHub Actions**.

---

## 1. Pubblicare l'app (una volta sola)

1. Su GitHub crea un repository **pubblico** (consigliato: `uilink-app`) e caricaci questi file.
2. **Settings → Pages**: in *Source* scegli **Deploy from a branch**, branch `main`, cartella `/ (root)`, poi **Save**.
3. Dopo 1–2 minuti l'app è online su `https://TUONOME.github.io/uilink-app/`.
4. **Actions → Aggiornamento giornaliero → Run workflow** per il primo aggiornamento. Poi parte da solo ogni mattina verso le 6:20.

### Aggiungerla alla Home dell'iPhone
Apri il link con **Safari**, tocca **Condividi** (il quadrato con la freccia) e scegli **Aggiungi alla schermata Home**.
L'app si apre a tutto schermo, con l'icona UILink.

---

## 2. Follower automatici

Finché non colleghi i social puoi inserire i numeri a mano, toccando la matita ✎ su ogni riquadro.

I valori segreti si inseriscono su GitHub in **Settings → Secrets and variables → Actions → New repository secret**.

### Instagram + Facebook (account Creator collegato a una Pagina Facebook)
1. Su [developers.facebook.com](https://developers.facebook.com) crea un'app di tipo **Business**.
2. Con lo strumento **Graph API Explorer** genera un token utente con i permessi
   `pages_show_list`, `pages_read_engagement`, `instagram_basic`, `business_management`.
3. Trasformalo in token di lunga durata. Poi, da `GET /me/accounts`, copia l'`access_token` della pagina UILink: è un **token di pagina che non scade**.
4. Crea i secret:
   - `META_PAGE_ID` → l'ID della pagina (es. `61588254296752`)
   - `META_PAGE_TOKEN` → il token di pagina

Instagram deve essere collegato alla Pagina Facebook (Instagram → Impostazioni → Centro gestione account).

### TikTok
1. Su [developers.tiktok.com](https://developers.tiktok.com) crea un'app e aggiungi il prodotto **Login Kit** con gli scope `user.info.basic` e `user.info.stats`.
2. Come *Redirect URI* inserisci `https://TUONOME.github.io/uilink-app/tiktok-callback.html`.
3. Crea i secret `TIKTOK_CLIENT_KEY` e `TIKTOK_CLIENT_SECRET`.
4. Crea un **token GitHub** (*Settings personali → Developer settings → Fine-grained tokens*) con accesso solo a questo repository e permesso **Secrets: Read and write**. Salvalo come secret `GH_PAT`: serve a rinnovare da solo il token TikTok.
5. In `data/config.json` inserisci la *Client key* nel campo `tiktokClientKey`.
6. Nell'app tocca ✎ su TikTok, poi **Collega TikTok**, autorizza e segui le istruzioni a schermo (copi un codice e avvii l'azione *Collega TikTok*).

> L'app TikTok deve essere approvata da TikTok per l'uso pubblico. In modalità *Sandbox* funziona aggiungendo il tuo account tra i *target user*.

---

## 3. Modificare enti e fonti
Il file `data/fonti.json` contiene l'elenco degli enti monitorati.
- `keywords`: le parole usate per riconoscere l'ente nei bandi.
- `nazionale: true`: include anche i bandi nazionali di quell'ente aperti alla Calabria.
- `url`: la pagina "Lavora con noi".

## 4. Struttura
| File | Cosa fa |
|---|---|
| `index.html`, `styles.css`, `app.js` | l'app |
| `scripts/scrape.py` | raccolta dei bandi e lettura dei PDF |
| `scripts/followers.py` | conteggio dei follower |
| `data/jobs.json` | bandi del giorno (generato) |
| `.github/workflows/aggiorna.yml` | aggiornamento automatico quotidiano |

## Limiti
- Il testo del video è costruito con regole automatiche, senza intelligenza artificiale. Per circa il 70% dei bandi titoli di studio, requisiti e mansioni sono già compilati; il resto va completato a mano (i campi sono tra `[parentesi quadre]`).
- Il sito Lavoro Regione Calabria non rispondeva durante lo sviluppo, quindi per ora è presente come link rapido nella sezione fonti.
- Le aziende private (Enel, Eni, Terna, FS…) pubblicano le offerte su portali propri: vengono intercettate quando passano da inPA o dagli aggregatori, e sono sempre raggiungibili dalla sezione "Enti e fonti monitorate".
