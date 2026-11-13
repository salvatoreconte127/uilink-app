#!/usr/bin/env python3
"""UILink Concorsi Calabria – raccolta giornaliera dei bandi.

Fonti: inPA (API pubblica), ConcorsiPubblici.com (Calabria), Concorsando (Calabria).
Scrive data/jobs.json. Solo libreria standard Python, pensato per GitHub Actions.
"""
from __future__ import annotations

import html
import json
import re
import sys
import time
import unicodedata
import urllib.error
import urllib.request
from datetime import datetime, timedelta, timezone
from pathlib import Path
from zoneinfo import ZoneInfo

ROMA = ZoneInfo("Europe/Rome")


def giorno_roma(ts: str | None) -> str:
    """Data ISO UTC -> giorno (YYYY-MM-DD) secondo l'ora italiana."""
    if not ts:
        return ""
    try:
        return datetime.fromisoformat(ts.replace("Z", "+00:00")).astimezone(ROMA).date().isoformat()
    except ValueError:
        return ts[:10]

ROOT = Path(__file__).resolve().parent.parent
DATA = ROOT / "data"
OUT = DATA / "jobs.json"
FONTI = json.loads((DATA / "fonti.json").read_text(encoding="utf-8"))

UA = ("Mozilla/5.0 (iPhone; CPU iPhone OS 17_0 like Mac OS X) AppleWebKit/605.1.15 "
      "(KHTML, like Gecko) Version/17.0 Mobile/15E148 Safari/604.1")
NOW = datetime.now(timezone.utc)
TODAY = NOW.astimezone(ZoneInfo("Europe/Rome")).date().isoformat()
PROVINCE = ["Cosenza", "Catanzaro", "Crotone", "Vibo Valentia", "Reggio Calabria"]
ALTRE_REGIONI = re.compile(r"\b(piemonte|valle d.aosta|lombardia|trentino|alto adige|veneto|friuli|liguria|"
                           r"emilia|toscana|umbria|marche|lazio|abruzzo|molise|campania|puglia|basilicata|"
                           r"sicilia|sardegna)\b", re.I)


def altra_regione(*texts) -> bool:
    t = " ".join(x or "" for x in texts)
    return bool(ALTRE_REGIONI.search(t)) and "calabria" not in t.lower()
MAX_DETAILS = 80  # dettagli nuovi scaricati per fonte a ogni esecuzione

log = lambda *a: print(*a, file=sys.stderr, flush=True)


# ---------------------------------------------------------------- utilità HTTP
def fetch(url: str, data: bytes | None = None, headers: dict | None = None, tries: int = 3) -> str:
    h = {"User-Agent": UA, "Accept-Language": "it-IT,it;q=0.9"}
    h.update(headers or {})
    for i in range(tries):
        try:
            req = urllib.request.Request(url, data=data, headers=h)
            with urllib.request.urlopen(req, timeout=45) as r:
                return r.read().decode("utf-8", errors="replace")
        except (urllib.error.URLError, TimeoutError, ConnectionError) as e:
            log(f"  ! {url} -> {e} (tentativo {i + 1})")
            time.sleep(2 * (i + 1))
    raise RuntimeError(f"impossibile scaricare {url}")


def fetch_json(url, body=None):
    data = json.dumps(body).encode() if body is not None else None
    hdr = {"Origin": "https://www.inpa.gov.it", "Accept": "application/json"}
    if data:
        hdr["Content-Type"] = "application/json"
    return json.loads(fetch(url, data, hdr))


# ---------------------------------------------------------------- utilità testo
def strip_html(s: str | None) -> str:
    if not s:
        return ""
    s = re.sub(r"(?is)<(script|style).*?</\1>", " ", s)
    s = re.sub(r"(?i)<br\s*/?>|</p>|</li>|</div>|</h\d>", "\n", s)
    s = re.sub(r"(?i)<li[^>]*>", "\n• ", s)
    s = re.sub(r"<[^>]+>", " ", s)
    s = html.unescape(s).replace("\xa0", " ")
    s = re.sub(r"[ \t\r\f\v]+", " ", s)
    s = re.sub(r"\n\s*", "\n", s)
    return s.strip()


def norm(s: str) -> str:
    s = unicodedata.normalize("NFKD", s or "").encode("ascii", "ignore").decode().lower()
    return re.sub(r"[^a-z0-9]+", " ", s).strip()


def clip(s: str, n: int) -> str:
    s = (s or "").strip()
    return s if len(s) <= n else s[: n - 1].rsplit(" ", 1)[0] + "…"


ABBR = re.compile(r"(?i)\b(artt?|nn?|cat|ex|lett|comma|pag|ecc|sig|dott|prof|rif|tab|all|cfr|"
                  r"d\.\s?lgs|d\.\s?m|d\.\s?l|d\.\s?p\.\s?r|t\.\s?u\.\s?e\.\s?l|s\.\s?p\.\s?a|[a-z])\.(?=\s*\S)")


def sentences(text: str):
    text = ABBR.sub(lambda m: m.group(0).replace(".", "§"), text)
    for part in re.split(r"(?<=[.;!?])\s+(?=[A-ZÀ-Ü0-9•(])|\n+", text):
        part = part.replace("§", ".").strip(" •-–\t")
        if 15 < len(part) < 500:
            yield part


PREAMBOLO = re.compile(r"^(vist[oaie]|richiamat|considerat|dato atto|preso atto|ritenut|rilevat|atteso|"
                       r"accertat|in esecuzione|in attuazione|ai sensi|il responsabile|il dirigente|determina|"
                       r"delibera|art\.?\s*\d)", re.I)


def pick(text: str, pattern: str, limit=3, maxlen=420, exclude: str = "") -> str:
    rx = re.compile(pattern, re.I)
    ex = re.compile(exclude, re.I) if exclude else None
    out, seen = [], set()
    for s in sentences(text):
        if PREAMBOLO.search(s) or re.search(r"\b(d\.\s?lgs|legge|d\.p\.r|decreto)\b.{0,25}\bn\.", s, re.I) and len(s) < 160:
            continue
        if ex and ex.search(s):
            continue
        if rx.search(s) and norm(s) not in seen:
            seen.add(norm(s))
            out.append(s)
            if len(out) >= limit:
                break
    return clip("\n".join(out), maxlen)


def section(text: str, head: str, maxlen=600) -> str:
    """Testo che segue un'intestazione (es. REQUISITI) fino alla successiva intestazione maiuscola."""
    m = re.search(head + r"[^\n]*\n(.+?)(?:\n[A-ZÀ-Ü][A-ZÀ-Ü '’]{6,}\n|\Z)", text, re.S | re.I)
    return clip(m.group(1).strip(), maxlen) if m else ""


TITOLI_RX = (r"\blaurea\b|\bdiploma\b|licenza media|scuola dell.obbligo|titolo di studio|"
             r"\bmaturit|\bL/SNT|\bLM-|\bclasse L|abilitazion|iscrizione all.(albo|ordine)|specializzazione")
MANSIONI_RX = (r"\bmansioni\b(?! specifiche del profilo)|\bcompiti\b|si occuper|dovr[aà] (svolgere|occuparsi|garantire)|"
               r"svolger[aà]|attivit[aà] (di|da svolgere|previste)|declaratoria")
MANSIONI_EX = r"idone|accerta|cause di|al fine di|ricorrono|esclusion|valutazion|punteggio"
REQUISITI_RX = (r"cittadinanza|et[aà] (non inferiore|minima)|idoneit[aà] fisica|godimento dei diritti|"
                r"patente|esperienza|requisit|iscrizione|conoscenza della lingua|non aver riportato")


def contratto(text: str) -> str:
    t = text.lower()
    parts = []
    if "indeterminato" in t:
        parts.append("tempo indeterminato")
    elif "determinato" in t:
        parts.append("tempo determinato")
    if "part time" in t or "part-time" in t or "parziale" in t:
        parts.append("part time")
    elif "pieno" in t or "full time" in t:
        parts.append("tempo pieno")
    if "mobilit" in t:
        parts.append("mobilità")
    return ", ".join(parts)


def posti_da_testo(text: str):
    m = re.search(r"\bn\.?\s*(\d{1,4})\s*(?:\(|posti|unit|post)", text, re.I) or \
        re.search(r"\b(\d{1,4})\s+(?:posti|unit[àa])", text, re.I)
    return int(m.group(1)) if m else None


def sedi_da_testo(text: str):
    t = text.lower()
    return [p for p in PROVINCE if p.lower() in t]


# ---------------------------------------------------------------- enti monitorati
ENTI = []
for e in FONTI["enti"]:
    rx = [re.compile(r"(?<![a-z])" + re.escape(norm(k)) + r"(?![a-z])") for k in e.get("keywords", []) if k.strip()]
    if rx:
        ENTI.append((e, rx))


def match_enti(*texts):
    blob = " " + norm(" ".join(t for t in texts if t)) + " "
    found = []
    for e, rxs in ENTI:
        if any(r.search(blob) for r in rxs):
            found.append(e)
    return found


def categoria(item, enti):
    if enti:
        # preferisci la categoria più specifica (evita "portali")
        for e in enti:
            if e["categoria"] != "portali":
                return e["categoria"]
    t = norm(item["ente"] + " " + item["titolo"])
    if re.search(r"\b(asp|azienda sanitaria|ospedal|sanit|infermier|medic)", t):
        return "sanita"
    if re.search(r"\b(scuol|universit|conservatorio|accademia|docent|istituto comprensivo|liceo)", t):
        return "istruzione"
    if re.search(r"\b(militar|esercito|carabinier|polizia di stato|finanza|vigili del fuoco)", t):
        return "forze"
    if re.search(r"\bcomune\b|\bprovincia\b|unione dei comuni|regione calabria", t):
        return "comuni"
    return "altro"


# ---------------------------------------------------------------- fonte: inPA
INPA_SEARCH = "https://portale.inpa.gov.it/concorsi-smart/api/concorso-public-area/search-better?page={p}&size=100"
INPA_DETAIL = "https://portale.inpa.gov.it/concorsi-smart/api/concorso-public-area/{id}"
INPA_PAGE = "https://www.inpa.gov.it/bandi-e-avvisi/dettaglio-bando-avviso/?concorso_id={id}"
INPA_MEDIA = "https://portale.inpa.gov.it/api/media/{id}"


def from_inpa(cache):
    items, n_det = [], 0
    for p in range(0, 20):
        d = fetch_json(INPA_SEARCH.format(p=p), {"text": "", "regioneId": "3", "status": ["OPEN"]})
        content = d.get("content") or []
        for x in content:
            sedi = [s for s in x.get("sedi", []) if s not in ("Calabria", "Nazionale")]
            nazionale = "Nazionale" in x.get("sedi", [])
            ente = (x.get("entiRiferimento") or [""])[0].replace("_", " - ")
            enti = match_enti(ente, x.get("titolo", ""))
            if nazionale and (not any(e.get("nazionale") for e in enti) or altra_regione(ente, x.get("titolo"))):
                continue  # bando nazionale di un ente non monitorato o riferito a un'altra regione
            key = "inpa:" + x["id"]
            det = cache.get(key)
            if det is None and n_det < MAX_DETAILS:
                try:
                    det = fetch_json(INPA_DETAIL.format(id=x["id"]))
                    n_det += 1
                    time.sleep(0.3)
                except Exception as e:  # noqa: BLE001
                    log("  ! dettaglio inPA", e)
            det = det or {}
            desc = strip_html(det.get("descrizione") or x.get("descrizione"))
            breve = strip_html(det.get("descrizioneBreve") or x.get("descrizioneBreve"))
            full = breve + "\n" + desc
            bando = next((a.get("mediaId") for a in det.get("allegati") or [] if a.get("tipo") == "BANDO_CONCORSO"),
                         x.get("allegatoMediaId"))
            items.append({
                "id": key,
                "inpaId": x["id"],
                "fonti": ["inPA"],
                "titolo": clip(x.get("titolo", ""), 300),
                "ente": ente,
                "profilo": x.get("figuraRicercata") or "",
                "sedi": sedi or (["Nazionale"] if nazionale else ["Calabria"]),
                "nazionale": nazionale,
                "posti": x.get("numPosti"),
                "scadenza": giorno_roma(x.get("dataScadenza")),
                "pubblicazione": giorno_roma(x.get("dataPubblicazione")),
                "contratto": contratto(x.get("titolo", "") + " " + full[:1500]),
                "descrizione": clip(breve or desc, 600),
                "mansioni": pick(desc, MANSIONI_RX, 3, exclude=MANSIONI_EX),
                "titoliStudio": pick(full, TITOLI_RX, 3),
                "requisiti": section(desc, r"REQUISITI") or pick(desc, REQUISITI_RX, 4),
                "prove": ("Per " + " e ".join(w.lower() for w in (x.get("tipoProcedura") or "").split("_"))
                          if x.get("tipoProcedura") else ""),
                "candidatura": "Domanda esclusivamente online sul portale inPA (accesso con SPID, CIE o CNS)"
                               + (", con indirizzo PEC personale" if det.get("pecObbligatoria") else "") + ".",
                "linkBando": INPA_MEDIA.format(id=bando) if bando else "",
                "link": INPA_PAGE.format(id=x["id"]),
                "linkEnte": det.get("linkSitoPA") or "",
                "_det": det and {k: det.get(k) for k in ("descrizione", "descrizioneBreve", "allegati",
                                                         "pecObbligatoria", "linkSitoPA")},
                "_enti": [e["nome"] for e in enti],
            })
        if d.get("last", True) or not content:
            break
    log(f"inPA: {len(items)} bandi")
    return items


# ---------------------------------------------------------------- fonte: ConcorsiPubblici.com
CP_BASE = "https://www.concorsipubblici.com"
CP_LIST = CP_BASE + "/concorsi/regione/loc/calabria?page={p}"


def cp_field(block: str, name: str) -> str:
    m = re.search(r'field--name-field-' + name + r'\b.*?(?=<div class="field field--name|<h4|</article|\Z)',
                  block, re.S)
    if not m:
        return ""
    s = re.sub(r'<div class="field__label">.*?</div>', "", m.group(0), flags=re.S)
    return strip_html('<div class="' + s)


def from_concorsipubblici(cache):
    items, seen, n_det = [], set(), 0
    for p in range(0, 15):
        try:
            h = fetch(CP_LIST.format(p=p))
        except RuntimeError:
            break
        arts = re.findall(r'<article[^>]*node--type-contest[^>]*>(.*?)</article>', h, re.S)
        new = 0
        for a in arts:
            m = re.search(r'<h2 class="contest-title">\s*<a href="([^"]+)"[^>]*>\s*<span>(.*?)</span>', a, re.S)
            if not m or m.group(1) in seen:
                continue
            seen.add(m.group(1))
            new += 1
            url = CP_BASE + m.group(1)
            sc = re.search(r'<time datetime="(\d{4}-\d{2}-\d{2})', a)
            posti = cp_field(a, "available-slots")
            it = {
                "id": "cp:" + m.group(1).strip("/"),
                "fonti": ["ConcorsiPubblici"],
                "titolo": strip_html(m.group(2)),
                "ente": cp_field(a, "authority"),
                "profilo": cp_field(a, "employment").replace("\n", ", "),
                "sedi": [s for s in cp_field(a, "localities").split("\n") if s] or ["Calabria"],
                "nazionale": False,
                "posti": int(posti) if posti.isdigit() else None,
                "scadenza": sc.group(1) if sc else "",
                "pubblicazione": "",
                "descrizione": clip(cp_field(a, "body") or strip_html(re.search(
                    r'field--name-body.*?>(.*?)</div>', a, re.S).group(1) if 'field--name-body' in a else ""), 600),
                "link": url,
            }
            det = cache.get(it["id"])
            if det is None and n_det < MAX_DETAILS:
                try:
                    dh = fetch(url)
                    n_det += 1
                    time.sleep(2.5)
                    body = re.search(r'field--name-body[^>]*>(.*?)</div>', dh, re.S)
                    pdf = re.search(r'href="([^"]+\.pdf)"', dh)
                    det = {
                        "requisiti": cp_field(dh, "requirements"),
                        "titoli": cp_field(dh, "educational-qualification"),
                        "prove": cp_field(dh, "exam-tests"),
                        "domanda": cp_field(dh, "application-form-address"),
                        "contratto": cp_field(dh, "contract"),
                        "body": strip_html(body.group(1)) if body else "",
                        "pdf": (CP_BASE + pdf.group(1)) if pdf and pdf.group(1).startswith("/") else (pdf.group(1) if pdf else ""),
                    }
                except Exception as e:  # noqa: BLE001
                    log("  ! dettaglio CP", e)
            det = det or {}
            body = det.get("body", "")
            req = det.get("requisiti", "")
            dom = det.get("domanda", "")
            inpa = re.search(r"concorso_id=([0-9a-f]{32})", dom)
            it.update({
                "inpaId": inpa.group(1) if inpa else None,
                "contratto": (det.get("contratto") or contratto(it["titolo"] + " " + it["descrizione"])).lower(),
                "mansioni": pick(body + "\n" + it["descrizione"], MANSIONI_RX, 3, exclude=MANSIONI_EX),
                "titoliStudio": clip("\n".join(x for x in [pick(req, TITOLI_RX, 3), det.get("titoli", "")] if x), 420),
                "requisiti": clip(req, 600),
                "prove": clip(det.get("prove", ""), 300),
                "candidatura": ("Domanda online sul portale inPA (SPID, CIE o CNS)." if inpa else clip(dom, 300)),
                "linkBando": det.get("pdf", ""),
                "_det": det,
            })
            it["_enti"] = [e["nome"] for e in match_enti(it["ente"], it["titolo"])]
            items.append(it)
        if new == 0:
            break
        time.sleep(1.0)
    log(f"ConcorsiPubblici: {len(items)} bandi")
    return items


# ---------------------------------------------------------------- fonte: Concorsando
CD_PAGE = "https://www.concorsando.it/blog/concorsi-calabria/"
CD_SCHEDA = "https://www.concorsando.it/blog/wp-json/filtribandi/v1/bandi/{id}/scheda"


def from_concorsando(cache):
    items, n_det = [], 0
    h = fetch(CD_PAGE)
    for m in re.finditer(r'<a class="filtribandi-card[^"]*"(.*?)>(.*?)</a>', h, re.S):
        attrs, inner = m.group(1), m.group(2)
        g = lambda k: (re.search(k + r'="([^"]*)"', attrs) or [None, ""])[1]
        cid, href = g("data-id"), g("href")
        if not cid:
            continue
        titolo = strip_html((re.search(r'filtribandi-titolo">(.*?)</h3>', inner, re.S) or [None, ""])[1])
        studio = strip_html((re.search(r'filtribandi-studio">.*?<span>(.*?)</span>', inner, re.S) or [None, ""])[1])
        fine = g("data-fine-ts")
        scad = datetime.fromtimestamp(int(fine), ROMA).date().isoformat() if fine.isdigit() else ""
        key = "cd:" + cid
        det = cache.get(key)
        if det is None and n_det < MAX_DETAILS:
            try:
                det = {"html": json.loads(fetch(CD_SCHEDA.format(id=cid))).get("html", "")}
                n_det += 1
                time.sleep(0.8)
            except Exception as e:  # noqa: BLE001
                log("  ! scheda Concorsando", e)
        det = det or {}
        sh = det.get("html", "")
        desc = strip_html((re.search(r'filtribandi-dett-descrizione">(.*?)</div>', sh, re.S) or [None, ""])[1])
        ente = strip_html((re.search(r'filtribandi-dett-ente-nome">(.*?)</strong>', sh, re.S) or [None, ""])[1])
        links = re.findall(r'class="filtribandi-dett-link"[^>]*href="([^"]+)"[^>]*>([^<]+)', sh) + \
            [(b, a) for a, b in re.findall(r'href="([^"]+)"[^>]*class="filtribandi-dett-link"[^>]*>([^<]+)', sh)]
        links = [(u.replace("&amp;", "&"), t.strip()) for u, t in links]
        bando = next((u for u, t in links if "bando" in t.lower()), "")
        inpa = re.search(r"concorso_id=([0-9a-f]{32})", sh)
        cerca = html.unescape(g("data-cerca"))
        nazionale = "," in g("data-regione")
        enti = match_enti(ente, titolo, cerca)
        if nazionale and (not any(e.get("nazionale") for e in enti) or altra_regione(ente, titolo)):
            continue
        items.append({
            "id": key,
            "inpaId": inpa.group(1) if inpa else None,
            "fonti": ["Concorsando"],
            "titolo": titolo,
            "ente": ente.title() if ente.isupper() else ente,
            "profilo": "",
            "sedi": sedi_da_testo(titolo + " " + ente + " " + desc) or (["Nazionale"] if nazionale else ["Calabria"]),
            "nazionale": nazionale,
            "posti": posti_da_testo(titolo),
            "scadenza": scad,
            "pubblicazione": "",
            "contratto": contratto(titolo + " " + desc),
            "descrizione": clip(desc, 600),
            "mansioni": pick(desc, MANSIONI_RX, 3, exclude=MANSIONI_EX),
            "titoliStudio": clip(pick(desc, TITOLI_RX, 3) or studio, 420),
            "requisiti": pick(desc, REQUISITI_RX, 4),
            "prove": pick(desc, r"prov[ae]|colloquio|preselettiv|titoli ed esami|per titoli", 2, 300),
            "candidatura": "Domanda online sul portale inPA (SPID, CIE o CNS)." if inpa else "",
            "linkBando": bando,
            "link": href,
            "_det": det,
            "_enti": [e["nome"] for e in enti],
        })
    log(f"Concorsando: {len(items)} bandi")
    return items


# ---------------------------------------------------------------- PDF del bando
MAX_PDF = 70


def pdf_fields(url: str) -> dict:
    try:
        import io
        import pypdf  # installato nel workflow (requirements.txt)
    except ImportError:
        return {}
    req = urllib.request.Request(url, headers={"User-Agent": UA})
    with urllib.request.urlopen(req, timeout=60) as r:
        raw = r.read(12_000_000)
    if not raw.startswith(b"%PDF"):
        return {}
    reader = pypdf.PdfReader(io.BytesIO(raw))
    text = "\n".join((pg.extract_text() or "") for pg in reader.pages[:14])
    text = re.sub(r"[ \t]+", " ", text)
    text = re.sub(r"(?<![.;:])\n(?=[a-zà-ü(])", " ", text)  # ricuci righe spezzate
    dom = pick(text, r"domand[ae].{0,80}(presentat|inviat|trasmess|inoltrat)|"
                     r"(pec|posta elettronica certificata|raccomandata|portale inpa|www\.inpa)", 2, 380)
    return {
        "titoliStudio": pick(text, TITOLI_RX, 3),
        "requisiti": pick(text, REQUISITI_RX, 5, 650, exclude=r"circolare|indirizzi operativi|ai fini della|si procede"),
        "mansioni": pick(text, MANSIONI_RX, 3, exclude=MANSIONI_EX),
        "candidatura": dom,
        "_len": len(text),
    }


def enrich_from_pdf(items, cache, new_cache):
    n = 0
    for it in items:
        url = it.get("linkBando") or ""
        if not url or all(it.get(f) for f in ("titoliStudio", "requisiti", "mansioni")):
            continue
        key = "pdf:" + url
        f = cache.get(key)
        if f is None and n < MAX_PDF:
            n += 1
            try:
                f = pdf_fields(url)
                time.sleep(0.5)
            except Exception as e:  # noqa: BLE001
                log("  ! PDF", url, e)
                f = None
        if f is None:
            continue
        new_cache[key] = f
        for k in ("titoliStudio", "requisiti", "mansioni"):
            if not it.get(k) and f.get(k):
                it[k] = f[k]
        if not it.get("candidatura") and f.get("candidatura"):
            it["candidatura"] = f["candidatura"]
    log(f"PDF letti: {n}")


# ---------------------------------------------------------------- unione e salvataggio
FIELDS_TEXT = ["profilo", "descrizione", "mansioni", "titoliStudio", "requisiti", "prove", "candidatura",
               "linkBando", "contratto", "pubblicazione", "linkEnte"]


def merge(a, b):
    """Unisce b dentro a (stesso bando da due fonti), tenendo i campi più ricchi."""
    for f in FIELDS_TEXT:
        if len(str(b.get(f) or "")) > len(str(a.get(f) or "")):
            a[f] = b[f]
    for f in ("posti", "scadenza", "inpaId"):
        a[f] = a.get(f) or b.get(f)
    if a.get("sedi") in (["Calabria"], ["Nazionale"]) and b.get("sedi") not in (["Calabria"], ["Nazionale"]):
        a["sedi"] = b["sedi"]
    a["fonti"] = sorted(set(a["fonti"]) | set(b["fonti"]))
    a.setdefault("altriLink", [])
    if b.get("link") and b["link"] != a.get("link"):
        a["altriLink"].append(b["link"])
    a["_enti"] = sorted(set(a.get("_enti", [])) | set(b.get("_enti", [])))
    return a


def dedup_key(it):
    if it.get("inpaId"):
        return "inpa:" + it["inpaId"]
    return "t:" + norm(it["ente"])[:40] + "|" + (it.get("scadenza") or "") + "|" + str(it.get("posti") or "")


def main():
    old = {}
    if OUT.exists():
        try:
            for j in json.loads(OUT.read_text(encoding="utf-8")).get("bandi", []):
                old[j["id"]] = j
        except Exception:  # noqa: BLE001
            pass
    cache_path = DATA / ".cache.json"
    cache = json.loads(cache_path.read_text()) if cache_path.exists() else {}

    raw, stato = [], {}
    for name, fn in (("inPA", from_inpa), ("ConcorsiPubblici", from_concorsipubblici), ("Concorsando", from_concorsando)):
        try:
            got = fn(cache)
            raw += got
            stato[name] = {"ok": True, "bandi": len(got)}
        except Exception as e:  # noqa: BLE001
            log(f"!! fonte {name} non disponibile: {e}")
            stato[name] = {"ok": False, "errore": str(e)[:200]}

    # aggiorna cache dettagli (solo bandi ancora presenti)
    new_cache = {}
    for it in raw:
        if it.get("_det"):
            new_cache[it["id"]] = it["_det"]
    merged = {}
    for it in raw:
        it.pop("_det", None)
        k = dedup_key(it)
        merged[k] = merge(merged[k], it) if k in merged else it

    enrich_from_pdf([x for x in merged.values() if not x.get("scadenza") or x["scadenza"] >= TODAY], cache, new_cache)
    cache_path.write_text(json.dumps(new_cache, ensure_ascii=False))

    out = []
    for k, it in merged.items():
        if it.get("scadenza") and it["scadenza"] < TODAY:
            continue
        prev = old.get(it["id"]) or next((o for o in old.values() if o.get("key") == k), None)
        it["key"] = k
        it["primaVista"] = (prev or {}).get("primaVista") or TODAY
        if not it.get("scadenza") and it["primaVista"] < (NOW - timedelta(days=45)).date().isoformat():
            continue
        enti = it.pop("_enti", [])
        it["entiMonitorati"] = enti
        it["categoria"] = categoria(it, [e for e in FONTI["enti"] if e["nome"] in enti])
        out.append(it)

    out.sort(key=lambda x: (x["primaVista"] != TODAY, x.get("scadenza") or "9999"))
    OUT.write_text(json.dumps({
        "aggiornato": NOW.isoformat(timespec="minutes"),
        "fonti": stato,
        "totale": len(out),
        "nuoviOggi": sum(1 for x in out if x["primaVista"] == TODAY),
        "bandi": out,
    }, ensure_ascii=False, indent=1), encoding="utf-8")
    log(f"Salvati {len(out)} bandi ({sum(1 for x in out if x['primaVista'] == TODAY)} nuovi oggi)")


if __name__ == "__main__":
    main()
