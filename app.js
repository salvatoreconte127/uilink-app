/* UILink Concorsi Calabria — web app */
(() => {
  "use strict";

  const $ = (s, r = document) => r.querySelector(s);
  const LS = {
    get(k, d) { try { const v = localStorage.getItem("uilink." + k); return v ? JSON.parse(v) : d; } catch { return d; } },
    set(k, v) { try { localStorage.setItem("uilink." + k, JSON.stringify(v)); } catch { /* privato */ } },
  };
  const esc = (s) => String(s ?? "").replace(/[&<>"']/g, (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" }[c]));
  const fmtN = (n) => new Intl.NumberFormat("it-IT").format(n);
  const DAY = 864e5;
  const todayISO = () => new Date().toISOString().slice(0, 10);
  const daysTo = (iso) => { if (!iso) return null; const t = new Date(); t.setHours(0, 0, 0, 0); return Math.round((new Date(iso + "T00:00:00") - t) / DAY); };
  const dataLunga = (iso) => iso ? new Date(iso + "T12:00:00").toLocaleDateString("it-IT", { weekday: "long", day: "numeric", month: "long", year: "numeric" }) : "";
  const dataBreve = (iso) => iso ? new Date(iso + "T12:00:00").toLocaleDateString("it-IT", { day: "numeric", month: "short" }) : "";

  let JOBS = [], FONTI = null, CONFIG = {}, FOLLOWERS = {};
  let filter = LS.get("filter", "tutte");
  let query = "";
  const selected = new Set(LS.get("sel", []));
  const open = new Set();
  let hookIdx = 0;
  const fCitta = new Set(LS.get("fCitta", []));
  const fEnti = new Set(LS.get("fEnti", []));
  let enteQ = "";

  /* ------------------------------------------------ util */
  function toast(msg) {
    const t = $("#toast");
    t.textContent = msg;
    t.classList.add("show");
    clearTimeout(toast._t);
    toast._t = setTimeout(() => t.classList.remove("show"), 1800);
  }

  async function copy(text) {
    try {
      await navigator.clipboard.writeText(text);
      return true;
    } catch {
      const ta = document.createElement("textarea");
      ta.value = text; ta.setAttribute("readonly", ""); ta.style.position = "fixed"; ta.style.opacity = "0";
      document.body.appendChild(ta); ta.select(); ta.setSelectionRange(0, text.length);
      const ok = document.execCommand("copy");
      ta.remove();
      return ok;
    }
  }

  async function getJSON(url) {
    const r = await fetch(url + (url.includes("?") ? "&" : "?") + "t=" + Date.now(), { cache: "no-store" });
    if (!r.ok) throw new Error(url + " " + r.status);
    return r.json();
  }

  /* testo MAIUSCOLO -> frase normale */
  function sentenceCase(s) {
    s = String(s || "").trim();
    const letters = s.replace(/[^A-Za-zÀ-ÿ]/g, "");
    if (letters && letters.replace(/[^A-ZÀ-Þ]/g, "").length / letters.length > 0.6) {
      s = s.toLowerCase().replace(/(^|[.!?]\s+)([a-zà-ÿ])/g, (m, a, b) => a + b.toUpperCase());
      s = s.replace(/\b(asp|ao|aou|inps|inail|enav|anas|rfi|cnr|enea|afam|usr|gom|pnrr|ccnl|tuel|cat|ea|eq|oss|it)\b/gi, (m) => m.toUpperCase());
      s = s.replace(/\b(calabria|cosenza|catanzaro|crotone|vibo valentia|reggio calabria|lamezia terme|italia)\b/gi,
        (m) => m.replace(/\b\w/g, (c) => c.toUpperCase()));
    }
    return s;
  }
  const cap = (s) => (s = String(s || "").trim()) ? s[0].toUpperCase() + s.slice(1) : s;

  /* profilo breve dal titolo */
  function profilo(j) {
    let p = j.profilo || "";
    if (!p) {
      const m = (j.titolo || "").match(/(?:posti?|unit[àa]|figur[ae])\s+(?:di|nel profilo(?: professionale)? di|con (?:il )?profilo(?: professionale)? di)\s+[«"“]?(.+?)(?:[»"”]|,|\s+[-–(]|\s+a tempo|\s+presso|\s+per\s|\s+da\s|\s+cat\.|\s+area|$)/i);
      p = m ? m[1] : "";
    }
    p = sentenceCase(p.replace(/\s*-\s*personale del comparto.*$/i, "").replace(/\s*\(.*$/, "")).trim();
    return p.length > 70 ? p.slice(0, 68).replace(/\s\S*$/, "") + "…" : p;
  }

  function shortTitle(j) {
    const p = profilo(j);
    if (p) return (j.posti ? `${j.posti} ${j.posti === 1 ? "posto" : "posti"} · ` : "") + cap(p);
    const t = sentenceCase(j.titolo);
    return t.length > 110 ? t.slice(0, 108).replace(/\s\S*$/, "") + "…" : t;
  }

  const enteNome = (j) => sentenceCase((j.ente || "").replace(/\s+-\s+.*$/, (m) => m.length > 40 ? "" : m));
  const PROVINCE = ["Cosenza", "Catanzaro", "Crotone", "Vibo Valentia", "Reggio Calabria"];
  const provNorm = (x) => (x === "Reggio di Calabria" ? "Reggio Calabria" : x);
  const cittaOf = (j) => {
    const all = (j.sedi || []).map(provNorm);
    const c = all.filter((x) => PROVINCE.includes(x));
    if (c.length) return c;
    const fuori = all.some((x) => x && x !== "Calabria" && !PROVINCE.includes(x));
    return [j.nazionale || fuori ? "Tutta Italia" : "Calabria"];
  };
  const passFacets = (j) => (!fCitta.size || cittaOf(j).some((c) => fCitta.has(c))) && (!fEnti.size || fEnti.has(enteNome(j)));
  const sedi = (j) => { const c = cittaOf(j); return c[0] === "Tutta Italia" ? "Tutta Italia (anche Calabria)" : c.join(", "); };

  /* ------------------------------------------------ social */
  const ICONS = {
    instagram: `<svg viewBox="0 0 40 40"><defs><linearGradient id="igg" x1="0" y1="1" x2="1" y2="0"><stop offset="0" stop-color="#FEDA75"/><stop offset=".35" stop-color="#FA7E1E"/><stop offset=".6" stop-color="#D62976"/><stop offset=".85" stop-color="#962FBF"/><stop offset="1" stop-color="#4F5BD5"/></linearGradient></defs><rect width="40" height="40" rx="11" fill="url(#igg)"/><rect x="9" y="9" width="22" height="22" rx="7" fill="none" stroke="#fff" stroke-width="2.6"/><circle cx="20" cy="20" r="5.3" fill="none" stroke="#fff" stroke-width="2.6"/><circle cx="26.6" cy="13.4" r="1.6" fill="#fff"/></svg>`,
    tiktok: `<svg viewBox="0 0 40 40"><rect width="40" height="40" rx="11" fill="#000"/><g transform="translate(8 7) scale(1.05)"><path fill="#25F4EE" transform="translate(-.8 -.6)" d="M16.6 5.8a4.3 4.3 0 0 1-1-2.8h-3.1v12.4a2.6 2.6 0 1 1-2.6-2.6c.3 0 .5 0 .8.1V9.7a5.7 5.7 0 1 0 4.9 5.7V9.1a7.4 7.4 0 0 0 4.3 1.4V7.4a4.3 4.3 0 0 1-3.3-1.6z"/><path fill="#FE2C55" transform="translate(.8 .6)" d="M16.6 5.8a4.3 4.3 0 0 1-1-2.8h-3.1v12.4a2.6 2.6 0 1 1-2.6-2.6c.3 0 .5 0 .8.1V9.7a5.7 5.7 0 1 0 4.9 5.7V9.1a7.4 7.4 0 0 0 4.3 1.4V7.4a4.3 4.3 0 0 1-3.3-1.6z"/><path fill="#fff" d="M16.6 5.8a4.3 4.3 0 0 1-1-2.8h-3.1v12.4a2.6 2.6 0 1 1-2.6-2.6c.3 0 .5 0 .8.1V9.7a5.7 5.7 0 1 0 4.9 5.7V9.1a7.4 7.4 0 0 0 4.3 1.4V7.4a4.3 4.3 0 0 1-3.3-1.6z"/></g></svg>`,
    facebook: `<svg viewBox="0 0 40 40"><rect width="40" height="40" rx="11" fill="#1877F2"/><path fill="#fff" d="M26.2 13.4h-3c-1.2 0-1.6.7-1.6 1.7v2.6h4.5l-.7 4.6h-3.8V34h-5V22.3h-3.8v-4.6h3.8v-3.3c0-3.9 2.2-6 5.7-6 1.7 0 3.2.1 3.9.2v4.8z"/></svg>`,
  };
  const SOCIAL = [
    { k: "instagram", name: "Instagram" },
    { k: "tiktok", name: "TikTok" },
    { k: "facebook", name: "Facebook" },
  ];

  function followerValue(k) {
    const a = FOLLOWERS[k];
    const m = LS.get("manual", {})[k];
    if (a && (!m || a.aggiornato >= m.aggiornato)) return a;
    return m || null;
  }

  function renderSocial() {
    const links = CONFIG.social || {};
    $("#social").innerHTML = SOCIAL.map(({ k, name }) => {
      const v = followerValue(k);
      const when = v ? new Date(v.aggiornato) : null;
      const meta = v ? (v.auto ? "auto · " : "manuale · ") + when.toLocaleDateString("it-IT", { day: "numeric", month: "short" }) : "da inserire";
      return `<a class="glass social" href="${esc(links[k] || "#")}" target="_blank" rel="noopener" aria-label="${name}: ${v ? fmtN(v.count) : "non disponibile"} follower">
        <button class="edit" data-edit="${k}" aria-label="Modifica follower ${name}"><svg viewBox="0 0 24 24"><path d="M4 20h4L19 9l-4-4L4 16v4z"/></svg></button>
        <span class="ico">${ICONS[k]}</span>
        <span class="num ${v ? "" : "na"}">${v ? fmtN(v.count) : "—"}</span>
        <span class="name">${name}</span>
        <span class="meta">${meta}</span>
      </a>`;
    }).join("");
  }

  function editFollowers(k) {
    const d = $("#fDialog");
    const name = SOCIAL.find((s) => s.k === k).name;
    $("#fTitle").textContent = `Follower ${name}`;
    $("#fHint").textContent = FOLLOWERS[k]?.auto
      ? "Questo numero si aggiorna da solo ogni mattina. Un valore manuale resta valido fino al prossimo aggiornamento automatico."
      : "Inserisci il numero attuale di follower. Quando il collegamento automatico sarà attivo si aggiornerà da solo.";
    $("#fInput").value = followerValue(k)?.count ?? "";
    const tt = $("#ttConnect");
    if (k === "tiktok" && CONFIG.tiktokClientKey) {
      const redirect = new URL("tiktok-callback.html", location.href).href.split("?")[0];
      tt.href = "https://www.tiktok.com/v2/auth/authorize/?" + new URLSearchParams({
        client_key: CONFIG.tiktokClientKey, scope: "user.info.basic,user.info.stats",
        response_type: "code", redirect_uri: redirect, state: Math.random().toString(36).slice(2),
      });
      tt.hidden = false;
    } else tt.hidden = true;
    d.returnValue = "";
    d.onclose = () => {
      if (d.returnValue !== "ok") return;
      const n = parseInt($("#fInput").value, 10);
      const manual = LS.get("manual", {});
      if (Number.isFinite(n) && n >= 0) manual[k] = { count: n, aggiornato: new Date().toISOString(), auto: false };
      else delete manual[k];
      LS.set("manual", manual);
      renderSocial();
      toast("Follower aggiornati");
    };
    d.showModal();
    setTimeout(() => $("#fInput").focus(), 50);
  }

  /* ------------------------------------------------ filtri */
  const CATS = [
    ["tutte", "Tutte"],
    ["nuove", "Nuove oggi"],
    ["scadenza", "In scadenza"],
    ["sanita", "Sanità"],
    ["comuni", "Comuni e Regione"],
    ["istruzione", "Scuola, Università, AFAM"],
    ["calabria", "Enti calabresi"],
    ["aziende", "Aziende ed enti nazionali"],
    ["forze", "Forze armate"],
    ["selezionate", "Selezionate"],
  ];

  function matches(j, f) {
    if (f === "tutte") return true;
    if (f === "nuove") return j.primaVista === LATEST;
    if (f === "scadenza") { const d = daysTo(j.scadenza); return d !== null && d <= 7; }
    if (f === "selezionate") return selected.has(j.id);
    return j.categoria === f;
  }

  let LATEST = todayISO();

  function renderChips() {
    $("#chips").innerHTML = CATS.map(([k, label]) => {
      const n = JOBS.filter((j) => matches(j, k) && passFacets(j)).length;
      if (!n && !["tutte", filter].includes(k)) return "";
      return `<button class="chip" role="tab" aria-selected="${k === filter}" data-f="${k}">${label}<small>${n}</small></button>`;
    }).join("");
  }

  function renderStats() {
    const nuovi = JOBS.filter((j) => j.primaVista === LATEST).length;
    const posti = JOBS.reduce((a, j) => a + (j.posti || 0), 0);
    const urg = JOBS.filter((j) => { const d = daysTo(j.scadenza); return d !== null && d <= 7; }).length;
    $("#stats").innerHTML = `
      <div class="stat"><b>${nuovi}</b><span>nuove oggi</span></div>
      <div class="stat"><b>${JOBS.length}</b><span>bandi</span></div>
      <div class="stat"><b>${fmtN(posti)}</b><span>posti</span></div>
      <div class="stat"><b>${urg}</b><span>urgenti</span></div>`;
  }

  /* ------------------------------------------------ lista */
  function renderJobs() {
    const q = query.trim().toLowerCase();
    const list = JOBS.filter((j) => matches(j, filter) && passFacets(j) && (!q ||
      [j.titolo, j.ente, j.profilo, (j.sedi || []).join(" "), j.descrizione].join(" ").toLowerCase().includes(q)));
    const box = $("#jobs");
    if (!list.length) {
      box.innerHTML = `<p class="empty">${JOBS.length ? "Nessuna opportunità con questi filtri." : "Nessun dato disponibile al momento."}</p>`;
      return;
    }
    box.innerHTML = list.map((j) => {
      const d = daysTo(j.scadenza);
      const sel = selected.has(j.id);
      const isOpen = open.has(j.id);
      const tags = [];
      if (j.primaVista === LATEST) tags.push(`<span class="tag new">NUOVO</span>`);
      if (d !== null) tags.push(`<span class="tag ${d <= 3 ? "hot" : d <= 7 ? "warn" : ""}">⏰ ${d <= 0 ? "scade oggi" : d === 1 ? "scade domani" : "scade " + dataBreve(j.scadenza)}</span>`);
      cittaOf(j).forEach((c) => tags.push(`<button class="tag tag-btn ${fCitta.has(c) ? "on" : ""}" data-citta="${esc(c)}" aria-label="Filtra per ${esc(c)}">📍 ${esc(c)}</button>`));
      if (j.posti) tags.push(`<span class="tag">👥 ${j.posti} ${j.posti === 1 ? "posto" : "posti"}</span>`);
      if (j.entiMonitorati?.length) tags.push(`<span class="tag watch">★ ${esc(j.entiMonitorati[0].replace(/^AFAM – /, "AFAM · "))}</span>`);
      const more = isOpen ? `<div class="job-more">
          ${j.descrizione ? `<p>${esc(sentenceCase(j.descrizione))}</p>` : ""}
          ${j.contratto ? `<p><b>Contratto:</b> ${esc(j.contratto)}</p>` : ""}
          ${j.titoliStudio ? `<p><b>Titolo di studio:</b> ${esc(j.titoliStudio)}</p>` : ""}
          ${j.requisiti ? `<p><b>Requisiti:</b> ${esc(j.requisiti)}</p>` : ""}
          ${j.candidatura ? `<p><b>Domanda:</b> ${esc(j.candidatura)}</p>` : ""}
          <p><b>Fonte:</b> ${esc(j.fonti.join(", "))}</p>
          <div class="job-links">
            ${j.link ? `<a href="${esc(j.link)}" target="_blank" rel="noopener">Apri scheda ↗</a>` : ""}
            ${j.linkBando ? `<a href="${esc(j.linkBando)}" target="_blank" rel="noopener">Bando PDF ↗</a>` : ""}
            ${j.linkEnte ? `<a href="${esc(j.linkEnte)}" target="_blank" rel="noopener">Sito ente ↗</a>` : ""}
            <a href="#" data-copylink="${esc(j.link)}">Copia link</a>
          </div>
        </div>` : "";
      return `<article class="glass job ${sel ? "sel" : ""}" data-id="${esc(j.id)}">
        <button class="check" data-sel="${esc(j.id)}" aria-pressed="${sel}" aria-label="Seleziona"><svg viewBox="0 0 24 24"><path d="m5 12 5 5 9-10"/></svg></button>
        <h3 class="job-title" data-sel="${esc(j.id)}">${esc(shortTitle(j))}</h3>
        <button class="job-ente ${fEnti.has(enteNome(j)) ? "on" : ""}" data-ente="${esc(enteNome(j))}" aria-label="Filtra per ${esc(enteNome(j))}">${esc(enteNome(j))}</button>
        <div class="tags">${tags.join("")}</div>
        ${more}
        <button class="toggle" data-open="${esc(j.id)}">${isOpen ? "Mostra meno" : "Dettagli"}</button>
      </article>`;
    }).join("");
  }

  function renderSelection() {
    for (const id of [...selected]) if (!JOBS.some((j) => j.id === id)) selected.delete(id);
    LS.set("sel", [...selected]);
    $("#selCount").textContent = selected.size;
    $("#actionBar").hidden = selected.size === 0;
  }

  function renderAll() { renderStats(); renderChips(); renderActiveFilters(); renderJobs(); renderSelection(); }

  /* ------------------------------------------------ filtri enti e città */
  function saveFacets() {
    LS.set("fCitta", [...fCitta]);
    LS.set("fEnti", [...fEnti]);
  }
  function toggleFacet(set, v) {
    set.has(v) ? set.delete(v) : set.add(v);
    saveFacets();
  }
  function refreshAfterFacets() {
    renderChips(); renderActiveFilters(); renderJobs();
    if (!$("#fsheet").hidden) renderFilterSheet();
  }
  function renderActiveFilters() {
    const n = fCitta.size + fEnti.size;
    const badge = $("#fBadge");
    badge.hidden = !n; badge.textContent = n;
    $("#openFilters").classList.toggle("on", n > 0);
    const pills = [...fCitta].map((c) => `<button class="pill" data-rm-citta="${esc(c)}">📍 ${esc(c)} <span aria-hidden="true">✕</span></button>`)
      .concat([...fEnti].map((e) => `<button class="pill" data-rm-ente="${esc(e)}">🏛️ ${esc(e)} <span aria-hidden="true">✕</span></button>`));
    if (n > 1) pills.push(`<button class="pill clear" data-rm-all>Azzera filtri</button>`);
    $("#activeFilters").innerHTML = pills.join("");
  }
  const ORDINE_CITTA = ["Cosenza", "Catanzaro", "Reggio Calabria", "Crotone", "Vibo Valentia", "Calabria", "Tutta Italia"];
  function renderFilterSheet() {
    const cc = {};
    JOBS.forEach((j) => cittaOf(j).forEach((c) => { cc[c] = (cc[c] || 0) + 1; }));
    const citta = Object.keys(cc).sort((a, b) => ((ORDINE_CITTA.indexOf(a) + 1) || 99) - ((ORDINE_CITTA.indexOf(b) + 1) || 99) || a.localeCompare(b));
    $("#fCitta").innerHTML = citta.map((c) =>
      `<button class="chip" aria-pressed="${fCitta.has(c)}" data-fc="${esc(c)}">${esc(c)}<small>${cc[c]}</small></button>`).join("");
    const ce = {};
    JOBS.filter((j) => !fCitta.size || cittaOf(j).some((c) => fCitta.has(c))).forEach((j) => { const e = enteNome(j); ce[e] = (ce[e] || 0) + 1; });
    [...fEnti].forEach((e) => { ce[e] = ce[e] || 0; });
    const q = enteQ.trim().toLowerCase();
    const enti = Object.keys(ce).filter((e) => !q || e.toLowerCase().includes(q))
      .sort((a, b) => (fEnti.has(b) - fEnti.has(a)) || ce[b] - ce[a] || a.localeCompare(b));
    $("#fEnti").innerHTML = enti.length ? enti.map((e) =>
      `<button class="facet-row" aria-pressed="${fEnti.has(e)}" data-fe="${esc(e)}"><span class="box"><svg viewBox="0 0 24 24"><path d="m5 12 5 5 9-10"/></svg></span><span class="fe-name">${esc(e)}</span><span class="fe-n">${ce[e]}</span></button>`).join("")
      : `<p class="hint">Nessun ente trovato.</p>`;
    const tot = JOBS.filter((j) => matches(j, filter) && passFacets(j)).length;
    $("#applyFilters").textContent = `Mostra ${tot} ${tot === 1 ? "risultato" : "risultati"}`;
  }
  function openFilters() {
    enteQ = ""; $("#fEnteQ").value = "";
    renderFilterSheet();
    $("#fsheet").hidden = false; $("#sheetBg").hidden = false;
    document.body.style.overflow = "hidden";
  }

  /* ------------------------------------------------ fonti */
  function renderSources() {
    if (!FONTI) return;
    $("#srcCount").textContent = FONTI.enti.length + " enti";
    $("#sources").innerHTML = Object.entries(FONTI.categorie).map(([k, label]) => {
      const enti = FONTI.enti.filter((e) => e.categoria === k);
      return `<h4 class="src-cat">${esc(label)}</h4>` + enti.map((e) => {
        const n = JOBS.filter((j) => j.entiMonitorati?.includes(e.nome)).length;
        return `<a class="src" href="${esc(e.url)}" target="_blank" rel="noopener"><span>${esc(e.nome)}</span><span>${n ? n + " bandi" : "Lavora con noi ↗"}</span></a>`;
      }).join("");
    }).join("");
  }

  /* ------------------------------------------------ testo video */
  const PH = (s) => `[${s}]`;
  const postiTxt = (n) => n ? `${n} ${n === 1 ? "posto" : "posti"}` : PH("numero posti");

  function bullets(text, max = 6) {
    if (!text) return "";
    const lines = String(text).split(/\n+|(?<=;)\s+/).map((l) => l.replace(/^[\s•\-–*\d.)]+/, "").trim()).filter((l) => l.length > 3);
    return lines.slice(0, max).map((l) => "• " + cap(sentenceCase(l))).join("\n");
  }

  function hooks(sel) {
    if (sel.length === 1) {
      const j = sel[0], p = profilo(j) || "nuove figure", e = enteNome(j), s = sedi(j);
      const n = j.posti;
      return [
        `🚨 ${e} assume! ${n ? postiTxt(n) + " come " : ""}${p}`,
        `💼 Lavoro in Calabria: ${n ? postiTxt(n) + " per " : "si cerca "}${p} a ${s}`,
        `📢 Nuovo bando a ${s}: ${n ? postiTxt(n) + " da " : ""}${p}. Ecco come candidarti`,
        `🔥 Restare in Calabria si può: ${e} cerca ${p}`,
      ];
    }
    const tot = sel.reduce((a, j) => a + (j.posti || 0), 0);
    const enti = new Set(sel.map(enteNome));
    const s = [...new Set(sel.flatMap((j) => cittaOf(j).filter((x) => PROVINCE.includes(x))))];
    if (enti.size === 1) {
      const e = [...enti][0];
      return [
        `🚨 ${e} assume: ${tot ? tot + " posti" : sel.length + " bandi"} aperti!`,
        `💼 ${sel.length} bandi di ${e}${tot ? " per " + tot + " posti" : ""}: ecco tutti i dettagli`,
        `📢 ${e} cerca personale${s.length ? " a " + s.join(", ") : ""}: non fartelo scappare`,
      ];
    }
    return [
      `🔥 ${sel.length} nuove opportunità di lavoro in Calabria${tot ? " · " + tot + " posti" : ""}!`,
      `💼 Lavoro in Calabria: ${sel.length} bandi aperti da non perdere`,
      `📢 Concorsi Calabria: ${tot ? tot + " posti" : sel.length + " bandi"}${s.length ? " tra " + s.slice(0, 4).join(", ") : ""}`,
    ];
  }

  function blocco(j, multi) {
    const d = daysTo(j.scadenza);
    const p = profilo(j);
    const out = [];
    const descr = j.descrizione ? sentenceCase(j.descrizione) : "";
    const spiegazione = `${enteNome(j)} ha pubblicato un ${/mobilit/i.test(j.titolo) ? "avviso di mobilità" : /avviso|selezione/i.test(j.titolo) ? "avviso di selezione" : "bando di concorso"}` +
      ` per ${postiTxt(j.posti)}${p ? " come " + p : ""}` + (j.contratto ? `, con contratto a ${j.contratto.replace(/^tempo/, "tempo")}` : "") + ".";
    if (!multi) {
      out.push("📌 POSTI DISPONIBILI", `${postiTxt(j.posti)}${p ? " – " + p : ""}`, "");
      out.push("📝 DI COSA SI TRATTA", spiegazione + (descr && descr.length < 260 && !/\b(art\.|d\.\s?lgs|comma|delibera|determina)/i.test(descr) && !descr.toLowerCase().startsWith((j.titolo || "").slice(0, 30).toLowerCase()) ? "\n" + descr : ""), "");
      out.push("🛠️ MANSIONI", bullets(j.mansioni, 3) || PH("mansioni previste dal bando"), "");
      out.push("📍 SEDE", sedi(j), "");
      out.push("🎓 TITOLO DI STUDIO", bullets(j.titoliStudio, 4) || PH("titolo di studio richiesto"), "");
      out.push("✅ REQUISITI", bullets(j.requisiti, 5) || PH("requisiti di ammissione"), "");
      if (j.prove) out.push("🧪 SELEZIONE", cap(sentenceCase(j.prove)), "");
      out.push("⏰ TERMINI E SCADENZE",
        j.scadenza ? `Domande entro ${dataLunga(j.scadenza)}${d !== null && d >= 0 ? ` (${d <= 1 ? "ultimi giorni!" : "mancano " + d + " giorni"})` : ""}.` : PH("data di scadenza"), "");
      out.push("📨 DOVE PRESENTARE LA DOMANDA", j.candidatura || PH("modalità di invio della domanda"), "");
    } else {
      out.push(`👉 ${enteNome(j)}`);
      out.push(`📌 ${postiTxt(j.posti)}${p ? " – " + p : ""}`);
      out.push(`📍 Sede: ${sedi(j)}`);
      out.push(`📝 ${spiegazione}`);
      out.push(`🛠️ Mansioni: ${(bullets(j.mansioni, 2) || PH("mansioni")).replace(/\n/g, " ")}`);
      out.push(`🎓 Titolo di studio: ${(bullets(j.titoliStudio, 2) || PH("titolo di studio")).replace(/^• /gm, "").replace(/\n/g, "; ")}`);
      out.push(`✅ Requisiti: ${(bullets(j.requisiti, 3) || PH("requisiti")).replace(/^• /gm, "").replace(/\n/g, "; ")}`);
      out.push(`⏰ Scadenza: ${j.scadenza ? dataLunga(j.scadenza) : PH("scadenza")}`);
      out.push(`📨 Domanda: ${j.candidatura || PH("dove presentare la domanda")}`);
      out.push("");
    }
    return out.join("\n");
  }

  function buildScript() {
    const sel = JOBS.filter((j) => selected.has(j.id)).sort((a, b) => (a.scadenza || "9").localeCompare(b.scadenza || "9"));
    if (!sel.length) return "";
    const h = hooks(sel);
    const title = h[hookIdx % h.length];
    const parts = [`🎯 TITOLO\n${title}`, ""];
    if (sel.length === 1) {
      parts.push(blocco(sel[0], false));
    } else {
      parts.push(`📝 IN BREVE\nOggi vi porto ${sel.length} opportunità di lavoro in Calabria, con ${postiTxt(sel.reduce((a, j) => a + (j.posti || 0), 0) || null)} complessivi. Vediamole una per una.`, "");
      sel.forEach((j, i) => parts.push(`${i + 1}️⃣ BANDO ${i + 1}\n` + blocco(j, true)));
    }
    parts.push("🔗 I link per candidarvi li trovate nel primo commento fissato o nella bio del canale!");
    parts.push("Seguite UILink Concorsi Calabria per non perdere nessuna opportunità: il lavoro in Calabria c'è, restiamo nella nostra terra! 💙");
    return parts.join("\n").replace(/\n{3,}/g, "\n\n").trim();
  }

  const selKey = () => [...selected].sort().join("|");

  function openSheet(regen = false) {
    const drafts = LS.get("drafts", {});
    const key = selKey();
    const ta = $("#script");
    ta.value = (!regen && drafts[key]) || buildScript();
    $("#sheet").hidden = false;
    $("#sheetBg").hidden = false;
    document.body.style.overflow = "hidden";
  }
  function closeSheet() {
    $("#sheet").hidden = true;
    $("#fsheet").hidden = true;
    $("#sheetBg").hidden = true;
    document.body.style.overflow = "";
  }
  function saveDraft() {
    const drafts = LS.get("drafts", {});
    drafts[selKey()] = $("#script").value;
    const keys = Object.keys(drafts);
    if (keys.length > 30) delete drafts[keys[0]];
    LS.set("drafts", drafts);
  }

  /* ------------------------------------------------ eventi */
  function bind() {
    $("#copyLink").addEventListener("click", async () => {
      const ok = await copy(CONFIG.linktree || $("#linktree").href);
      const b = $("#copyLink");
      b.classList.add("done"); b.querySelector("span").textContent = ok ? "Copiato!" : "Errore";
      if (navigator.vibrate) navigator.vibrate(15);
      toast(ok ? "Link copiato negli appunti" : "Copia non riuscita");
      setTimeout(() => { b.classList.remove("done"); b.querySelector("span").textContent = "Copia"; }, 1800);
    });

    $("#social").addEventListener("click", (e) => {
      const b = e.target.closest("[data-edit]");
      if (b) { e.preventDefault(); e.stopPropagation(); editFollowers(b.dataset.edit); }
    });

    $("#chips").addEventListener("click", (e) => {
      const c = e.target.closest("[data-f]");
      if (!c) return;
      filter = c.dataset.f; LS.set("filter", filter);
      renderChips(); renderJobs();
    });

    let t;
    $("#q").addEventListener("input", (e) => { clearTimeout(t); t = setTimeout(() => { query = e.target.value; renderJobs(); }, 120); });

    $("#jobs").addEventListener("click", async (e) => {
      const fc = e.target.closest("[data-citta]");
      const fe = e.target.closest("[data-ente]");
      if (fc || fe) {
        if (fc) toggleFacet(fCitta, fc.dataset.citta); else toggleFacet(fEnti, fe.dataset.ente);
        const v = fc ? fc.dataset.citta : fe.dataset.ente;
        toast(((fc ? fCitta : fEnti).has(v) ? "Filtro attivo: " : "Filtro rimosso: ") + v);
        refreshAfterFacets();
        return;
      }
      const s = e.target.closest("[data-sel]");
      const o = e.target.closest("[data-open]");
      const c = e.target.closest("[data-copylink]");
      if (c) { e.preventDefault(); if (await copy(c.dataset.copylink)) toast("Link del bando copiato"); return; }
      if (s) {
        const id = s.dataset.sel;
        selected.has(id) ? selected.delete(id) : selected.add(id);
        if (navigator.vibrate) navigator.vibrate(8);
        hookIdx = 0;
        renderSelection(); renderJobs(); if (filter === "selezionate") renderChips();
      } else if (o) {
        const id = o.dataset.open;
        open.has(id) ? open.delete(id) : open.add(id);
        renderJobs();
      }
    });

    $("#openFilters").addEventListener("click", openFilters);
    $("#closeFilters").addEventListener("click", closeSheet);
    $("#applyFilters").addEventListener("click", () => { closeSheet(); $("#jobs-title").scrollIntoView({ behavior: "smooth" }); });
    $("#resetFilters").addEventListener("click", () => { fCitta.clear(); fEnti.clear(); saveFacets(); refreshAfterFacets(); });
    $("#fCitta").addEventListener("click", (e) => {
      const b = e.target.closest("[data-fc]"); if (!b) return;
      toggleFacet(fCitta, b.dataset.fc); refreshAfterFacets();
    });
    $("#fEnti").addEventListener("click", (e) => {
      const b = e.target.closest("[data-fe]"); if (!b) return;
      toggleFacet(fEnti, b.dataset.fe); refreshAfterFacets();
    });
    $("#fEnteQ").addEventListener("input", (e) => { enteQ = e.target.value; renderFilterSheet(); });
    $("#activeFilters").addEventListener("click", (e) => {
      const b = e.target.closest("button"); if (!b) return;
      if (b.hasAttribute("data-rm-all")) { fCitta.clear(); fEnti.clear(); }
      else if (b.dataset.rmCitta) fCitta.delete(b.dataset.rmCitta);
      else if (b.dataset.rmEnte) fEnti.delete(b.dataset.rmEnte);
      saveFacets(); refreshAfterFacets();
    });

    $("#clearSel").addEventListener("click", () => { selected.clear(); renderSelection(); renderJobs(); renderChips(); });
    $("#makeText").addEventListener("click", () => openSheet(false));
    $("#closeSheet").addEventListener("click", closeSheet);
    $("#sheetBg").addEventListener("click", closeSheet);
    $("#script").addEventListener("input", saveDraft);
    $("#regen").addEventListener("click", () => {
      hookIdx++;
      const ta = $("#script");
      const newTitle = hooks(JOBS.filter((j) => selected.has(j.id)))[hookIdx % hooks(JOBS.filter((j) => selected.has(j.id))).length];
      // sostituisce solo la riga del titolo, mantenendo le modifiche fatte al resto
      ta.value = ta.value.replace(/(🎯 TITOLO\n)[^\n]*/, `$1${newTitle}`);
      saveDraft();
    });
    $("#copyScript").addEventListener("click", async () => toast(await copy($("#script").value) ? "Testo copiato negli appunti" : "Copia non riuscita"));
    $("#share").addEventListener("click", async () => {
      const text = $("#script").value;
      if (navigator.share) { try { await navigator.share({ text }); } catch { /* annullato */ } }
      else toast(await copy(text) ? "Testo copiato" : "Condivisione non disponibile");
    });
    document.addEventListener("keydown", (e) => { if (e.key === "Escape") closeSheet(); });
  }

  /* ------------------------------------------------ avvio */
  async function load() {
    const [cfg, jobs, fonti, fol] = await Promise.allSettled([
      getJSON("data/config.json"), getJSON("data/jobs.json"), getJSON("data/fonti.json"), getJSON("data/followers.json"),
    ]);
    CONFIG = cfg.value || {};
    FOLLOWERS = fol.value || {};
    FONTI = fonti.value || null;
    if (CONFIG.linktree) {
      $("#linktree").href = CONFIG.linktree;
      $("#linktree").textContent = CONFIG.linktree.replace(/^https?:\/\//, "");
    }
    renderSocial();
    if (jobs.status === "fulfilled") {
      const d = jobs.value;
      JOBS = d.bandi || [];
      LATEST = JOBS.reduce((m, j) => (j.primaVista > m ? j.primaVista : m), "");
      const up = new Date(d.aggiornato);
      $("#updated").textContent = "Aggiornato " + up.toLocaleDateString("it-IT", { day: "numeric", month: "short" }) + ", " + up.toLocaleTimeString("it-IT", { hour: "2-digit", minute: "2-digit" });
      const ko = Object.entries(d.fonti || {}).filter(([, v]) => !v.ok).map(([k]) => k);
      if (ko.length) $("#updated").textContent += " · non raggiungibili: " + ko.join(", ");
    } else {
      $("#jobs").innerHTML = `<p class="empty">Impossibile caricare le opportunità. Controlla la connessione e riapri l'app.</p>`;
    }
    renderAll();
    renderSources();
  }

  $("#today").textContent = new Date().toLocaleDateString("it-IT", { weekday: "long", day: "numeric", month: "long" });
  bind();
  load();

  if ("serviceWorker" in navigator && location.protocol === "https:") {
    // quando arriva una nuova versione dell'app, ricarica una volta per mostrarla subito
    const hadController = !!navigator.serviceWorker.controller;
    let reloaded = false;
    navigator.serviceWorker.addEventListener("controllerchange", () => {
      if (hadController && !reloaded) { reloaded = true; location.reload(); }
    });
    navigator.serviceWorker.register("sw.js", { updateViaCache: "none" })
      .then((reg) => reg.update())
      .catch(() => {});
  }
})();
