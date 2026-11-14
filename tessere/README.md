# Tessere – le tue tessere fedeltà in stile Wallet

Web app per iPhone (funziona anche su Android e computer) per tenere tutte le tessere fedeltà in un posto solo.

- **Aggiungi una tessera** con una foto scattata al momento, uno screenshot dell'app del negozio o una foto dalla libreria.
- **I bordi della tessera vengono trovati da soli** e l'immagine viene raddrizzata: nel Wallet la tessera ha lo stesso aspetto di quella vera. Se serve, sistemi i quattro angoli col dito (c'è la lente d'ingrandimento).
- **Il codice viene letto in automatico** (QR, EAN-13, EAN-8, UPC, Code 128, Code 39, Code 93, Codabar, ITF, PDF417, Aztec, Data Matrix).
  Se il codice è sul retro o non viene trovato, puoi inquadrarlo con la fotocamera, leggerlo da un'altra immagine o digitarlo.
- **Grafica del negozio**: scrivi il nome (Coop, Conad, Esselunga, Carrefour, Lidl, Eurospin, Despar, Penny, Aldi, MD, Pam, Crai, Bennet, Famila, NaturaSì, Decathlon, IKEA, MediaWorld, Sephora, laFeltrinelli…) e la tessera prende i colori e lo stile di quel negozio, con disegni legati al tipo di negozio (spesa, sport, casa, libri, bellezza, farmacia…) e il numero stampato sopra. Per i negozi non in elenco crea comunque una grafica dal nome. La foto resta salvata: con il selettore **Foto / Grafica negozio** scegli cosa vedere. Dal menu ··· → *Grafica dei negozi* la applichi a tutte le tessere riconosciute. I colori sono ispirati ai negozi (non sono i loghi ufficiali) e si possono cambiare.
- Tessera aperta: codice ridisegnato nitido su fondo bianco, con il numero sotto. Tocca il codice per vederlo **a schermo intero** (lo schermo resta acceso).
- Grafica in stile **Wallet di iPhone** con **vetro liquido**, tema chiaro e scuro automatici.
- **Funziona senza rete** (utile alla cassa quando il segnale manca).
- **Privacy**: le tessere restano solo sul telefono, niente server. Dal menu **···** puoi esportare e importare un backup.

## Usarla sull'iPhone
Una volta pubblicato il sito su GitHub Pages, l'app si trova su
`https://TUONOME.github.io/uilink-app/tessere/`.

Aprila con **Safari** → **Condividi** → **Aggiungi alla schermata Home**.
Usata dalla Home, iOS conserva le tessere in modo stabile.

> Fai ogni tanto un backup (menu ··· → *Esporta backup*): se cancelli i dati di Safari o cambi telefono, con il file di backup recuperi tutto.

## File
| File | Cosa fa |
|---|---|
| `index.html`, `styles.css`, `app.js` | l'app |
| `sw.js`, `manifest.webmanifest`, `icons/` | funzionamento offline e icona per la Home |
| `vendor/` | [zxing-wasm](https://github.com/Sec-ant/zxing-wasm) 3.1.6 (licenza MIT) per leggere e disegnare i codici |
