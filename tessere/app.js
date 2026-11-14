/* Tessere – le tue tessere fedeltà in stile Wallet.
   Tutto resta sul dispositivo (IndexedDB). Lettura e disegno dei codici con zxing-wasm. */
(() => {
  "use strict";

  const $ = (s, r = document) => r.querySelector(s);
  const $$ = (s, r = document) => [...r.querySelectorAll(s)];
  const CARD_RATIO = 1.586;           // formato carta di credito (ISO ID-1)
  const FACE_W = 1280, FACE_H = Math.round(FACE_W / CARD_RATIO);
  const PEEK = 62;                    // quanto si vede di ogni tessera nella pila

  /* ───────────── memoria (IndexedDB) ───────────── */
  const DB = {
    db: null,
    open() {
      if (this.db) return Promise.resolve(this.db);
      return new Promise((res, rej) => {
        const r = indexedDB.open("tessere", 1);
        r.onupgradeneeded = () => r.result.createObjectStore("cards", { keyPath: "id" });
        r.onsuccess = () => { this.db = r.result; res(this.db); };
        r.onerror = () => rej(r.error);
      });
    },
    async tx(mode, fn) {
      const db = await this.open();
      return new Promise((res, rej) => {
        const t = db.transaction("cards", mode);
        const out = fn(t.objectStore("cards"));
        t.oncomplete = () => res(out && "result" in out ? out.result : undefined);
        t.onerror = () => rej(t.error);
        t.onabort = () => rej(t.error || new Error("Operazione annullata"));
      });
    },
    all() { return this.tx("readonly", (s) => s.getAll()); },
    put(card) { return this.tx("readwrite", (s) => s.put(card)); },
    del(id) { return this.tx("readwrite", (s) => s.delete(id)); },
  };

  const settings = {
    get(k, d) { try { const v = localStorage.getItem("tessere." + k); return v == null ? d : JSON.parse(v); } catch { return d; } },
    set(k, v) { try { localStorage.setItem("tessere." + k, JSON.stringify(v)); } catch { /* niente */ } },
  };

  /* ───────────── codici a barre (zxing-wasm) ───────────── */
  const Z = window.ZXingWASM;
  let zxReady = false;
  const ZX_OVERRIDES = {
    locateFile: (path, prefix) => path.endsWith(".wasm") ? new URL("vendor/zxing_full.wasm?v=3.1.6", location.href).href : prefix + path,
  };
  if (Z) Z.prepareZXingModule({ overrides: ZX_OVERRIDES });
  const READ_FORMATS = ["QRCode", "MicroQRCode", "EAN13", "EAN8", "UPCA", "UPCE", "Code128", "Code39", "Code93",
    "Codabar", "ITF", "DataBar", "DataBarExp", "PDF417", "Aztec", "DataMatrix"];
  const WRITABLE = new Set(["QRCode", "EAN13", "EAN8", "UPCA", "UPCE", "Code128", "Code39", "Code93", "Codabar", "ITF", "PDF417", "AztecCode", "DataMatrix"]);
  const FORMAT_LABEL = {
    QRCode: "QR code", EAN13: "EAN-13", EAN8: "EAN-8", UPCA: "UPC-A", UPCE: "UPC-E", Code128: "Code 128", Code39: "Code 39",
    Code93: "Code 93", Codabar: "Codabar", ITF: "ITF", PDF417: "PDF417", AztecCode: "Aztec", DataMatrix: "Data Matrix", none: "Solo numero",
  };
  const MATRIX = new Set(["QRCode", "AztecCode", "DataMatrix"]);

  function normalizeFormat(f) {
    if (!f) return "Code128";
    if (WRITABLE.has(f)) return f;
    if (f === "MicroQRCode" || f.startsWith("QRCode") || f === "RMQRCode") return "QRCode";
    if (f.startsWith("Aztec")) return "AztecCode";
    if (f.startsWith("Code39")) return "Code39";
    if (f === "ITF14") return "ITF";
    if (f.includes("PDF417")) return "PDF417";
    return "Code128"; // DataBar e altri: ridisegnati come Code 128
  }

  async function scanImageData(imageData, harder = true) {
    if (!Z) return [];
    try {
      const res = await Z.readBarcodes(imageData, {
        formats: READ_FORMATS, tryHarder: harder, tryRotate: harder, tryInvert: harder, tryDownscale: true,
        maxNumberOfSymbols: 4,
      });
      zxReady = true;
      return res.filter((r) => r.isValid && r.text).map((r) => ({
        text: r.text, rawFormat: r.format, format: normalizeFormat(r.format),
        area: polyArea(r.position),
      })).sort((a, b) => b.area - a.area);
    } catch (e) {
      console.warn("Lettura codice non riuscita", e);
      return [];
    }
  }
  function polyArea(p) {
    if (!p) return 0;
    const pts = [p.topLeft, p.topRight, p.bottomRight, p.bottomLeft];
    let a = 0;
    for (let i = 0; i < 4; i++) { const q = pts[i], r = pts[(i + 1) % 4]; a += q.x * r.y - r.x * q.y; }
    return Math.abs(a / 2);
  }
  async function scanCanvas(canvas, harder = true) {
    const ctx = canvas.getContext("2d", { willReadFrequently: true });
    return scanImageData(ctx.getImageData(0, 0, canvas.width, canvas.height), harder);
  }

  const svgCache = new Map();
  async function barcodeSVG(text, format) {
    if (!text || format === "none" || !Z) return null;
    const key = format + "\u0000" + text;
    if (svgCache.has(key)) return svgCache.get(key);
    const r = await Z.writeBarcode(text, { format, withQuietZones: false, withHRT: false, ecLevel: MATRIX.has(format) ? "M" : undefined });
    if (r.error || !r.svg) throw new Error(r.error || "Codice non valido");
    const doc = new DOMParser().parseFromString(r.svg, "image/svg+xml");
    const svg = doc.documentElement;
    const w = svg.getAttribute("width"), h = svg.getAttribute("height");
    svg.setAttribute("viewBox", `0 0 ${w} ${h}`);
    svg.removeAttribute("width"); svg.removeAttribute("height");
    svg.setAttribute("shape-rendering", "crispEdges");
    if (!MATRIX.has(format)) svg.setAttribute("preserveAspectRatio", "none");
    svg.setAttribute("role", "img");
    svg.setAttribute("aria-label", (FORMAT_LABEL[format] || format) + ": " + text);
    $$("desc", svg).forEach((d) => d.remove());
    const out = new XMLSerializer().serializeToString(svg);
    svgCache.set(key, out);
    return out;
  }
  function codeClass(format) { return MATRIX.has(format) ? "matrix" : format === "PDF417" ? "pdf" : "linear"; }

  async function renderCode(box, text, format) {
    box.classList.remove("linear", "matrix", "pdf", "nocode");
    if (!text || format === "none") {
      box.classList.add("nocode");
      box.textContent = text ? "Mostra il numero alla cassa" : "Nessun codice";
      return true;
    }
    try {
      const svg = await barcodeSVG(text, format);
      box.classList.add(codeClass(format));
      box.innerHTML = svg;
      return true;
    } catch (e) {
      box.classList.add("nocode");
      box.textContent = "Impossibile disegnare questo codice";
      return false;
    }
  }

  /* scelta automatica del tipo, per i codici digitati a mano */
  function checkDigitOK(d) {
    const n = d.split("").map(Number), last = n.pop();
    let s = 0;
    n.reverse().forEach((v, i) => { s += v * (i % 2 === 0 ? 3 : 1); });
    return (10 - (s % 10)) % 10 === last;
  }
  function guessFormat(code) {
    const c = code.trim();
    if (!c) return "Code128";
    if (/^\d+$/.test(c)) {
      if (c.length === 13 && checkDigitOK(c)) return "EAN13";
      if (c.length === 8 && checkDigitOK(c)) return "EAN8";
      if (c.length === 12 && checkDigitOK(c)) return "UPCA";
    }
    if (/^https?:\/\//i.test(c) || c.length > 40) return "QRCode";
    if (/^[\x20-\x7e]+$/.test(c)) return "Code128";
    return "QRCode";
  }
  function prettyNumber(code) {
    const c = (code || "").trim();
    if (/^\d{9,}$/.test(c) && c.length <= 24) return c.replace(/(\d{4})(?=\d)/g, "$1 ");
    return c;
  }

  /* ───────────── colori ───────────── */
  function dominantColor(canvas) {
    const w = 48, h = 30, c = document.createElement("canvas");
    c.width = w; c.height = h;
    const x = c.getContext("2d", { willReadFrequently: true });
    x.drawImage(canvas, 0, 0, w, h);
    const d = x.getImageData(0, 0, w, h).data;
    const buckets = new Map();
    let ar = 0, ag = 0, ab = 0, n = 0;
    for (let i = 0; i < d.length; i += 4) {
      const r = d[i], g = d[i + 1], b = d[i + 2];
      ar += r; ag += g; ab += b; n++;
      const k = (r >> 4) << 8 | (g >> 4) << 4 | (b >> 4);
      const e = buckets.get(k) || { n: 0, r: 0, g: 0, b: 0 };
      e.n++; e.r += r; e.g += g; e.b += b;
      buckets.set(k, e);
    }
    let best = null;
    for (const e of buckets.values()) if (!best || e.n > best.n) best = e;
    if (!best) return "#555555";
    return rgbHex(best.r / best.n, best.g / best.n, best.b / best.n);
  }
  function paletteFrom(canvas) {
    const w = 32, h = 20, c = document.createElement("canvas");
    c.width = w; c.height = h;
    const x = c.getContext("2d", { willReadFrequently: true });
    x.drawImage(canvas, 0, 0, w, h);
    const d = x.getImageData(0, 0, w, h).data;
    const buckets = new Map();
    for (let i = 0; i < d.length; i += 4) {
      const k = (d[i] >> 5) << 6 | (d[i + 1] >> 5) << 3 | (d[i + 2] >> 5);
      const e = buckets.get(k) || { n: 0, r: 0, g: 0, b: 0 };
      e.n++; e.r += d[i]; e.g += d[i + 1]; e.b += d[i + 2];
      buckets.set(k, e);
    }
    return [...buckets.values()].sort((a, b) => b.n - a.n).slice(0, 4).map((e) => rgbHex(e.r / e.n, e.g / e.n, e.b / e.n));
  }
  function rgbHex(r, g, b) { return "#" + [r, g, b].map((v) => Math.round(v).toString(16).padStart(2, "0")).join(""); }
  function hexRgb(h) { const n = parseInt(h.slice(1), 16); return [n >> 16 & 255, n >> 8 & 255, n & 255]; }
  function luminance(h) {
    const [r, g, b] = hexRgb(h).map((v) => { v /= 255; return v <= .03928 ? v / 12.92 : ((v + .055) / 1.055) ** 2.4; });
    return .2126 * r + .7152 * g + .0722 * b;
  }
  function textOn(h) { return luminance(h) > .45 ? "#0b0b0f" : "#ffffff"; }

  /* ───────────── immagini ───────────── */
  function loadImageFile(file) {
    return new Promise((res, rej) => {
      const url = URL.createObjectURL(file);
      const img = new Image();
      img.onload = () => res({ img, url });
      img.onerror = () => { URL.revokeObjectURL(url); rej(new Error("Immagine non leggibile")); };
      img.src = url;
    });
  }
  function toCanvas(img, maxSide) {
    const w0 = img.naturalWidth || img.width, h0 = img.naturalHeight || img.height;
    const s = Math.min(1, maxSide / Math.max(w0, h0));
    const c = document.createElement("canvas");
    c.width = Math.max(1, Math.round(w0 * s)); c.height = Math.max(1, Math.round(h0 * s));
    const x = c.getContext("2d", { willReadFrequently: true });
    x.imageSmoothingQuality = "high";
    x.drawImage(img, 0, 0, c.width, c.height);
    return c;
  }
  function canvasBlob(c, type = "image/jpeg", q = .9) {
    return new Promise((res) => c.toBlob((b) => res(b), type, q));
  }
  function blobToDataURL(b) {
    return new Promise((res, rej) => { const r = new FileReader(); r.onload = () => res(r.result); r.onerror = () => rej(r.error); r.readAsDataURL(b); });
  }
  async function dataURLToBlob(u) { return (await fetch(u)).blob(); }

  /* omografia: trasforma il quadrilatero scelto in un rettangolo dritto */
  function solve(A, b) {
    const n = b.length;
    for (let i = 0; i < n; i++) {
      let p = i;
      for (let r = i + 1; r < n; r++) if (Math.abs(A[r][i]) > Math.abs(A[p][i])) p = r;
      [A[i], A[p]] = [A[p], A[i]]; [b[i], b[p]] = [b[p], b[i]];
      for (let r = i + 1; r < n; r++) {
        const f = A[r][i] / A[i][i];
        for (let c = i; c < n; c++) A[r][c] -= f * A[i][c];
        b[r] -= f * b[i];
      }
    }
    const x = new Array(n);
    for (let i = n - 1; i >= 0; i--) {
      let s = b[i];
      for (let c = i + 1; c < n; c++) s -= A[i][c] * x[c];
      x[i] = s / A[i][i];
    }
    return x;
  }
  function homography(from, to) {
    const A = [], b = [];
    for (let i = 0; i < 4; i++) {
      const [x, y] = from[i], [X, Y] = to[i];
      A.push([x, y, 1, 0, 0, 0, -X * x, -X * y]); b.push(X);
      A.push([0, 0, 0, x, y, 1, -Y * x, -Y * y]); b.push(Y);
    }
    return solve(A, b);
  }
  function warp(src, quad, W, H) {
    // se il ritaglio è molto più grande del risultato, rimpicciolisco prima (meno scalettature)
    const qw = Math.max(dist(quad[0], quad[1]), dist(quad[3], quad[2]));
    let s = Math.min(1, (W * 1.25) / qw);
    let source = src, q = quad;
    if (s < .95) {
      source = document.createElement("canvas");
      source.width = Math.max(1, Math.round(src.width * s)); source.height = Math.max(1, Math.round(src.height * s));
      const sx = source.getContext("2d");
      sx.imageSmoothingQuality = "high";
      sx.drawImage(src, 0, 0, source.width, source.height);
      q = quad.map(([x, y]) => [x * s, y * s]);
    }
    const sw = source.width, sh = source.height;
    const sd = source.getContext("2d", { willReadFrequently: true }).getImageData(0, 0, sw, sh).data;
    const h = homography([[0, 0], [W, 0], [W, H], [0, H]], q);
    const out = document.createElement("canvas");
    out.width = W; out.height = H;
    const ox = out.getContext("2d");
    const od = ox.createImageData(W, H);
    const o = od.data;
    let k = 0;
    for (let v = 0; v < H; v++) {
      const vv = v + .5;
      for (let u = 0; u < W; u++, k += 4) {
        const uu = u + .5;
        const den = h[6] * uu + h[7] * vv + 1;
        let x = (h[0] * uu + h[1] * vv + h[2]) / den - .5;
        let y = (h[3] * uu + h[4] * vv + h[5]) / den - .5;
        if (x < 0) x = 0; else if (x > sw - 1) x = sw - 1;
        if (y < 0) y = 0; else if (y > sh - 1) y = sh - 1;
        const x0 = x | 0, y0 = y | 0, x1 = Math.min(x0 + 1, sw - 1), y1 = Math.min(y0 + 1, sh - 1);
        const fx = x - x0, fy = y - y0;
        const i00 = (y0 * sw + x0) * 4, i10 = (y0 * sw + x1) * 4, i01 = (y1 * sw + x0) * 4, i11 = (y1 * sw + x1) * 4;
        for (let c = 0; c < 3; c++) {
          const a = sd[i00 + c] + (sd[i10 + c] - sd[i00 + c]) * fx;
          const b = sd[i01 + c] + (sd[i11 + c] - sd[i01 + c]) * fx;
          o[k + c] = a + (b - a) * fy;
        }
        o[k + 3] = 255;
      }
    }
    ox.putImageData(od, 0, 0);
    return out;
  }
  const dist = (a, b) => Math.hypot(a[0] - b[0], a[1] - b[1]);

  /* riconoscimento automatico dei bordi della tessera:
     bordi (Sobel) → rette (Hough) → miglior quadrilatero sostenuto dai bordi */
  function detectCard(src) {
    const maxSide = 420;
    const s = Math.min(1, maxSide / Math.max(src.width, src.height));
    const w = Math.max(8, Math.round(src.width * s)), h = Math.max(8, Math.round(src.height * s));
    const c = document.createElement("canvas");
    c.width = w; c.height = h;
    const cx = c.getContext("2d", { willReadFrequently: true });
    cx.imageSmoothingQuality = "high";
    cx.drawImage(src, 0, 0, w, h);
    const d = cx.getImageData(0, 0, w, h).data;
    // canali R, G, B separati: così si vedono anche i bordi tra colori di luminosità simile
    const chans = [0, 1, 2].map((ch) => {
      const a = new Float32Array(w * h);
      for (let i = ch, j = 0; j < a.length; i += 4, j++) a[j] = d[i];
      return a;
    });
    const blur = (a) => {
      const o = new Float32Array(a.length);
      for (let y = 0; y < h; y++) for (let x = 0; x < w; x++) {
        let t = 0, n = 0;
        for (let yy = Math.max(0, y - 1); yy <= Math.min(h - 1, y + 1); yy++)
          for (let xx = Math.max(0, x - 1); xx <= Math.min(w - 1, x + 1); xx++) { t += a[yy * w + xx]; n++; }
        o[y * w + x] = t / n;
      }
      return o;
    };
    const blurred = chans.map((a) => blur(blur(a)));
    const mag = new Float32Array(w * h), ang = new Float32Array(w * h);
    let maxM = 0;
    for (const g of blurred) for (let y = 1; y < h - 1; y++) for (let x = 1; x < w - 1; x++) {
      const i = y * w + x;
      const gx = -g[i - w - 1] - 2 * g[i - 1] - g[i + w - 1] + g[i - w + 1] + 2 * g[i + 1] + g[i + w + 1];
      const gy = -g[i - w - 1] - 2 * g[i - w] - g[i - w + 1] + g[i + w - 1] + 2 * g[i + w] + g[i + w + 1];
      const m = Math.hypot(gx, gy);
      if (m > mag[i]) { mag[i] = m; ang[i] = Math.atan2(gy, gx); }
      if (m > maxM) maxM = m;
    }
    if (maxM < 10) return null;
    // soglia: il 12% dei pixel più "forti"
    const hist = new Uint32Array(256);
    for (let i = 0; i < mag.length; i++) hist[Math.min(255, (mag[i] / maxM * 255) | 0)]++;
    let acc = 0, thr = 255;
    for (; thr > 0; thr--) { acc += hist[thr]; if (acc > mag.length * .2) break; }
    const T = Math.max(thr / 255 * maxM, maxM * .06);
    // Hough
    const NT = 180, diag = Math.ceil(Math.hypot(w, h)), NR = diag * 2 + 1;
    const cosT = new Float32Array(NT), sinT = new Float32Array(NT);
    for (let t = 0; t < NT; t++) { cosT[t] = Math.cos(t * Math.PI / NT); sinT[t] = Math.sin(t * Math.PI / NT); }
    const H = new Float32Array(NT * NR);
    for (let y = 1; y < h - 1; y++) for (let x = 1; x < w - 1; x++) {
      const i = y * w + x;
      if (mag[i] < T) continue;
      let a = ang[i]; if (a < 0) a += Math.PI; // direzione del gradiente = normale della retta
      const t0 = Math.round(a / Math.PI * NT);
      for (let dt = -6; dt <= 6; dt++) {
        let t = t0 + dt;
        if (t < 0) t += NT; else if (t >= NT) t -= NT;
        const r = Math.round(x * cosT[t] + y * sinT[t]) + diag;
        H[t * NR + r] += Math.min(1, mag[i] / (2 * T)); // conta la lunghezza, non solo il contrasto
      }
    }
    // picchi
    const peaks = [];
    for (let t = 0; t < NT; t++) for (let r = 0; r < NR; r++) {
      const v = H[t * NR + r];
      if (v < Math.min(w, h) * .12) continue;
      let isMax = true;
      for (let dt = -5; dt <= 5 && isMax; dt++) for (let dr = -6; dr <= 6; dr++) {
        if (!dt && !dr) continue;
        let tt = t + dt, rr = r + dr;
        if (tt < 0) { tt += NT; rr = NR - 1 - rr; } else if (tt >= NT) { tt -= NT; rr = NR - 1 - rr; }
        if (rr < 0 || rr >= NR) continue;
        if (H[tt * NR + rr] > v) { isMax = false; break; }
      }
      if (isMax) peaks.push({ t, r: r - diag, v });
    }
    peaks.sort((a, b) => b.v - a.v);
    const lines = peaks.slice(0, 26).map((p) => ({ ...p, th: p.t * Math.PI / NT }));
    const horiz = lines.filter((l) => Math.abs(l.th - Math.PI / 2) < Math.PI * .27);
    const vert = lines.filter((l) => l.th < Math.PI * .23 || l.th > Math.PI * .77);
    const inter = (a, b) => {
      const det = Math.cos(a.th) * Math.sin(b.th) - Math.sin(a.th) * Math.cos(b.th);
      if (Math.abs(det) < 1e-6) return null;
      return [(a.r * Math.sin(b.th) - b.r * Math.sin(a.th)) / det, (b.r * Math.cos(a.th) - a.r * Math.cos(b.th)) / det];
    };
    const support = (p, q) => {
      const len = dist(p, q), n = Math.max(8, Math.round(len / 2));
      const nx = -(q[1] - p[1]) / len, ny = (q[0] - p[0]) / len;
      let hit = 0;
      for (let k = 0; k <= n; k++) {
        const x = p[0] + (q[0] - p[0]) * k / n, y = p[1] + (q[1] - p[1]) * k / n;
        let ok = false;
        for (let o = -2; o <= 2 && !ok; o++) {
          const xi = Math.round(x + nx * o), yi = Math.round(y + ny * o);
          if (xi > 0 && yi > 0 && xi < w - 1 && yi < h - 1 && mag[yi * w + xi] >= T * .5) ok = true;
        }
        if (ok) hit++;
      }
      return hit / (n + 1);
    };
    const area = (q) => { let a = 0; for (let i = 0; i < 4; i++) { const p = q[i], r = q[(i + 1) % 4]; a += p[0] * r[1] - r[0] * p[1]; } return a / 2; };
    let best = null;
    for (let i = 0; i < horiz.length; i++) for (let j = i + 1; j < horiz.length; j++) {
      let [a, b] = [horiz[i], horiz[j]];
      if (Math.abs(a.th - b.th) > .35) continue;
      // a = in alto, b = in basso (rispetto al centro dell'immagine)
      const ya = (a.r - (w / 2) * Math.cos(a.th)) / Math.sin(a.th), yb = (b.r - (w / 2) * Math.cos(b.th)) / Math.sin(b.th);
      if (Math.abs(ya - yb) < h * .1) continue;
      if (ya > yb) [a, b] = [b, a];
      for (let k = 0; k < vert.length; k++) for (let m = k + 1; m < vert.length; m++) {
        let [l, r] = [vert[k], vert[m]];
        const xl = inter(l, { th: Math.PI / 2, r: h / 2 }), xr = inter(r, { th: Math.PI / 2, r: h / 2 });
        if (!xl || !xr || Math.abs(xl[0] - xr[0]) < w * .12) continue;
        if (xl[0] > xr[0]) [l, r] = [r, l];
        const q = [inter(a, l), inter(a, r), inter(b, r), inter(b, l)];
        if (q.some((p) => !p || p[0] < -w * .03 || p[1] < -h * .03 || p[0] > w * 1.03 || p[1] > h * 1.03)) continue;
        const A = area(q);
        if (A < w * h * .06 || A > w * h * .985) continue;
        // convesso
        let sgn = 0, convex = true;
        for (let z = 0; z < 4; z++) {
          const p0 = q[z], p1 = q[(z + 1) % 4], p2 = q[(z + 2) % 4];
          const cr = (p1[0] - p0[0]) * (p2[1] - p1[1]) - (p1[1] - p0[1]) * (p2[0] - p1[0]);
          if (z === 0) sgn = Math.sign(cr); else if (Math.sign(cr) !== sgn) convex = false;
        }
        if (!convex) continue;
        const sides = [support(q[0], q[1]), support(q[1], q[2]), support(q[2], q[3]), support(q[3], q[0])];
        const minS = Math.min(...sides);
        if (minS < .45) continue;
        const avgS = sides.reduce((x, y) => x + y, 0) / 4;
        const wq = (dist(q[0], q[1]) + dist(q[3], q[2])) / 2, hq = (dist(q[0], q[3]) + dist(q[1], q[2])) / 2;
        const ar = Math.max(wq, hq) / Math.min(wq, hq);
        const arScore = Math.exp(-((ar - CARD_RATIO) ** 2) / .18);
        const score = (avgS * .6 + minS * .4) * Math.pow(A / (w * h), .6) * (.55 + .45 * arScore);
        if (!best || score > best.score) best = { q, score };
      }
    }
    if (!best) return null;
    return best.q.map(([x, y]) => [Math.max(0, Math.min(src.width, x / s)), Math.max(0, Math.min(src.height, y / s))]);
  }

  /* ───────────── grafica dei negozi ─────────────
     Colori e stile ispirati ai negozi più diffusi (non sono i loghi ufficiali).
     deco: decorazione di sfondo; font: stile della scritta; cat: tipo di negozio (sceglie i disegni). */
  const BRANDS = [
    { id: "coop", re: /\b(coop|ipercoop|unicoop|novacoop|coop alleanza)\b/, label: "Coop", c1: "#e2001a", c2: "#b30016", accent: "#ffffff", deco: "wave", font: "rounded", weight: 900, program: "Carta Socio", cat: "food" },
    { id: "conad", re: /\bconad\b/, label: "Conad", c1: "#e30613", c2: "#f39200", accent: "#ffd200", deco: "sun", font: "sans", weight: 900, italic: true, program: "Carta Insieme", cat: "food" },
    { id: "esselunga", re: /\besselunga\b|\bfidaty\b|\bfìdaty\b/, label: "esselunga", c1: "#0a4ea2", c2: "#e3001b", accent: "#ffd100", deco: "band", font: "sans", weight: 800, transform: "lower", program: "Carta Fìdaty", cat: "food" },
    { id: "carrefour", re: /\bcarrefour\b/, label: "Carrefour", c1: "#004e9f", c2: "#e2001a", accent: "#ffffff", deco: "chevrons", font: "sans", weight: 800, program: "Carta Carrefour", cat: "food" },
    { id: "lidl", re: /\blidl\b/, label: "Lidl", c1: "#0050aa", c2: "#e60a14", accent: "#fff000", deco: "circle", font: "sans", weight: 900, program: "Lidl Plus", cat: "food", textOnAccent: "#0050aa" },
    { id: "eurospin", re: /\beurospin\b/, label: "Eurospin", c1: "#003da5", c2: "#e30613", accent: "#ffd400", deco: "circle", font: "sans", weight: 900, italic: true, cat: "food" },
    { id: "despar", re: /\b(despar|eurospar|interspar|spar)\b/, label: "Despar", c1: "#00843d", c2: "#e30613", accent: "#ffffff", deco: "wave", font: "sans", weight: 800, cat: "food" },
    { id: "penny", re: /\bpenny\b/, label: "PENNY", c1: "#cd1719", c2: "#a3121a", accent: "#ffed00", deco: "band", font: "condensed", weight: 900, cat: "food" },
    { id: "aldi", re: /\baldi\b/, label: "ALDI", c1: "#1c2a6b", c2: "#00b4dc", accent: "#f7a600", deco: "stripes", font: "sans", weight: 900, cat: "food" },
    { id: "md", re: /\bmd( discount)?\b/, label: "MD", c1: "#0a3d91", c2: "#e30613", accent: "#ffd200", deco: "band", font: "sans", weight: 900, italic: true, cat: "food" },
    { id: "pam", re: /\b(pam|panorama)\b/, label: "Pam", c1: "#d7141a", c2: "#009639", accent: "#ffffff", deco: "wave", font: "rounded", weight: 900, program: "Carta Per Te", cat: "food" },
    { id: "crai", re: /\bcrai\b/, label: "Crai", c1: "#e30613", c2: "#9c0010", accent: "#ffffff", deco: "wave", font: "rounded", weight: 900, cat: "food" },
    { id: "bennet", re: /\bbennet\b/, label: "Bennet", c1: "#e2001a", c2: "#8f0012", accent: "#ffffff", deco: "circle", font: "sans", weight: 900, cat: "food" },
    { id: "famila", re: /\bfamila\b/, label: "Famila", c1: "#e30613", c2: "#0b4ea2", accent: "#ffffff", deco: "wave", font: "rounded", weight: 900, cat: "food" },
    { id: "naturasi", re: /\bnatura ?s[iì]\b/, label: "NaturaSì", c1: "#4f8a2b", c2: "#2f5e17", accent: "#f2b700", deco: "wave", font: "serif", weight: 700, cat: "food" },
    { id: "decathlon", re: /\bdecathlon\b/, label: "DECATHLON", c1: "#0082c3", c2: "#005a8c", accent: "#ffffff", deco: "wave", font: "condensed", weight: 900, italic: true, cat: "sport" },
    { id: "ikea", re: /\bikea\b/, label: "IKEA", c1: "#0058a3", c2: "#003f7a", accent: "#ffdb00", deco: "band", font: "sans", weight: 900, program: "IKEA Family", cat: "home" },
    { id: "mediaworld", re: /\bmedia ?world\b/, label: "MediaWorld", c1: "#df0000", c2: "#1d1d1f", accent: "#ffffff", deco: "chevrons", font: "sans", weight: 900, cat: "tech" },
    { id: "sephora", re: /\bsephora\b/, label: "SEPHORA", c1: "#111111", c2: "#2a2a2a", accent: "#ffffff", deco: "stripes", font: "sans", weight: 600, tracking: 14, cat: "beauty" },
    { id: "feltrinelli", re: /\bfeltrinelli\b/, label: "laFeltrinelli", c1: "#e30613", c2: "#a5000f", accent: "#ffffff", deco: "band", font: "serif", weight: 700, cat: "book" },
  ];
  const ICONS = {
    cart: "M3 4h2l2.4 10.2a1.5 1.5 0 0 0 1.5 1.1h8.6a1.5 1.5 0 0 0 1.5-1.1L21 7H6.2M9.5 19.5h.01M17 19.5h.01",
    apple: "M12 7.5c-1.6-1.3-5-1.4-6.2 1.6-1.3 3.2.8 9 3.2 9.9 1.2.5 2-.3 3-.3s1.8.8 3 .3c2.4-.9 4.5-6.7 3.2-9.9C17 6.1 13.6 6.2 12 7.5ZM12 7.5c0-2 1-3.5 3-4.2",
    leaf: "M5 19c0-8 5-13 14-14-1 9-6 14-14 14ZM5 19l7-7",
    bag: "M5 8h14l-1 12H6L5 8ZM9 8V6a3 3 0 0 1 6 0v2",
    basket: "M3 10h18l-2 9H5l-2-9ZM7 10l4-6M17 10l-4-6M9.5 13.5v3M14.5 13.5v3",
    carrot: "M14.5 9.5 4.5 19.5M14.5 9.5c-3 3-6.5 7-10 10 3.5-1 8-3.5 11.5-6.5 1.4-1.2 1-3-1.5-3.5ZM15 9c1-2 3.5-3 5-2.5M15 9c-.5-2 .5-4.5 2-5.5",
    bread: "M4 11c0-3 3.6-5 8-5s8 2 8 5c0 1-.6 1.6-1.5 1.8V19H5.5v-6.2C4.6 12.6 4 12 4 11ZM9 9.5l-1 2M13 9.5l-1 2M17 9.5l-1 2",
    ball: "M12 3a9 9 0 1 0 0 18 9 9 0 0 0 0-18ZM12 7.5l4 3-1.5 4.5h-5L8 10.5ZM12 3v4.5M16 10.5l4.5-1.5M14.5 15l2.5 4M9.5 15 7 19M8 10.5 3.5 9",
    bike: "M6 17.5h.01M6 14a3.5 3.5 0 1 0 0 7 3.5 3.5 0 0 0 0-7ZM18 14a3.5 3.5 0 1 0 0 7 3.5 3.5 0 0 0 0-7ZM6 17.5l4-7h5.5l2.5 7M10 10.5 8.5 7H11M15.5 10.5 14.5 7h2.5",
    dumbbell: "M4 9v6M7 7v10M17 7v10M20 9v6M7 12h10",
    house: "M4 11l8-7 8 7v9H4zM10 20v-5h4v5",
    lamp: "M8 3h8l3 8H5zM12 11v8M8 20h8",
    sofa: "M4 12v6h16v-6M6 12V8h12v4M4 12h3v3h10v-3h3",
    book: "M5 4h9a3 3 0 0 1 3 3v13H8a3 3 0 0 1-3-3V4ZM5 17a3 3 0 0 1 3-3h9",
    sparkle: "M12 3l2 6 6 2-6 2-2 6-2-6-6-2 6-2 2-6Z",
    lipstick: "M9 21V12h6v9zM10 12V7l4-3v8",
    bottle: "M10 3h4v3l2 3v12H8V9l2-3V3ZM8 13h8",
    bolt: "M13 3 5 14h6l-1 7 8-11h-6l1-7Z",
    screen: "M3 5h18v11H3zM8 20h8M12 16v4",
    cross: "M9 3h6v6h6v6h-6v6H9v-6H3V9h6z",
    pill: "M8.5 15.5l7-7a3.5 3.5 0 0 0-5-5l-7 7a3.5 3.5 0 0 0 5 5ZM7 7l5 5",
    hanger: "M12 7.5a2 2 0 1 1 2-2M12 7.5V9L3 16h18l-9-7",
    star: "M12 3l2.7 5.6 6.1.9-4.4 4.3 1 6.1L12 17l-5.4 2.9 1-6.1L3.2 9.5l6.1-.9z",
    gift: "M4 10h16v10H4zM3 7h18v3H3zM12 7v13M12 7c-1-3-5-4-5-1.5S10 7 12 7Zm0 0c1-3 5-4 5-1.5S14 7 12 7Z",
  };
  const CAT_ICONS = {
    food: ["cart", "apple", "leaf", "basket", "carrot", "bread", "bag"],
    sport: ["ball", "bike", "dumbbell", "star"],
    home: ["house", "lamp", "sofa", "star"],
    book: ["book", "star", "leaf"],
    beauty: ["sparkle", "lipstick", "bottle", "star"],
    tech: ["bolt", "screen", "star"],
    pharma: ["cross", "pill", "leaf"],
    fashion: ["hanger", "bag", "sparkle"],
    shop: ["bag", "star", "gift", "sparkle"],
  };
  const CAT_RE = [
    ["food", /super|market|mercat|iper|discount|alimentar|spesa|frutta|macelleri|panific|forno|bio\b|gastronom|tigros|todis|sigma|simply|basko|unes|gigante|dec[oò]\b|tuod[iì]|prix|in'?s\b|ard\b|eurospar|carrefour/],
    ["pharma", /farmac|parafarm|salute|sanitar/],
    ["sport", /sport|palestr|gym|fitness|bici|cicl|running/],
    ["book", /libr|book|mondadori|giunti|edicol/],
    ["beauty", /profum|beauty|cosmet|douglas|tigot[aà]|acqua ?& ?sapone|kiko|estetic|parrucch/],
    ["tech", /world|unieuro|euronics|expert|trony|elettr|tech|apple store|gamestop/],
    ["home", /casa|home|leroy|brico|obi\b|mobili|arred|maison|tedi\b|kasanova|coin casa/],
    ["fashion", /zara|h ?& ?m|ovs|benetton|moda|abbigl|scarpe|calzat|primark|bershka|pull|intimissimi|calzedonia|tezenis/],
  ];
  const norm = (s) => (s || "").toLowerCase().replace(/[’']/g, "'");
  function findBrand(...texts) {
    const t = norm(texts.filter(Boolean).join(" "));
    if (!t.trim()) return null;
    return BRANDS.find((b) => b.re.test(t) || b.re.test(t.normalize("NFD").replace(/[̀-ͯ]/g, ""))) || null;
  }
  function guessCategory(name) {
    const t = norm(name);
    for (const [cat, re] of CAT_RE) if (re.test(t)) return cat;
    return "shop";
  }
  const NICE = ["#e4572e", "#2e86de", "#10ac84", "#8854d0", "#f7b731", "#eb3b5a", "#0fb9b1", "#3867d6", "#fa8231", "#20bf6b"];
  function hashColor(s) {
    let h = 0;
    for (const ch of s || "x") h = (h * 31 + ch.charCodeAt(0)) >>> 0;
    return NICE[h % NICE.length];
  }
  function mix(hex, to, t) {
    const a = hexRgb(hex), b = hexRgb(to);
    return rgbHex(a[0] + (b[0] - a[0]) * t, a[1] + (b[1] - a[1]) * t, a[2] + (b[2] - a[2]) * t);
  }
  function seeded(seed) {
    let s = 0;
    for (const ch of seed) s = (s * 33 + ch.charCodeAt(0)) >>> 0;
    return () => { s = (s * 1664525 + 1013904223) >>> 0; return s / 4294967296; };
  }
  const FONTS = {
    sans: '-apple-system, "SF Pro Display", "Helvetica Neue", "Segoe UI", Roboto, Arial, sans-serif',
    rounded: 'ui-rounded, "SF Pro Rounded", "Arial Rounded MT Bold", "Nunito", -apple-system, "Segoe UI", Roboto, sans-serif',
    serif: '"New York", ui-serif, Georgia, "Times New Roman", serif',
    condensed: '"SF Compact Display", "Helvetica Neue", "Arial Narrow", -apple-system, "Segoe UI", Roboto, sans-serif',
  };
  function drawIcon(x, name, cx, cy, size, rot = 0) {
    const d = ICONS[name];
    if (!d) return;
    x.save();
    x.translate(cx, cy); x.rotate(rot);
    const k = size / 24;
    x.scale(k, k); x.translate(-12, -12);
    x.lineWidth = 1.7; x.lineCap = "round"; x.lineJoin = "round";
    x.stroke(new Path2D(d));
    x.restore();
  }
  function roundRect(x, X, Y, w, h, r) {
    x.beginPath();
    x.moveTo(X + r, Y); x.arcTo(X + w, Y, X + w, Y + h, r); x.arcTo(X + w, Y + h, X, Y + h, r);
    x.arcTo(X, Y + h, X, Y, r); x.arcTo(X, Y, X + w, Y, r); x.closePath();
  }

  /* disegna la tessera con la grafica del negozio */
  function drawBrandFace({ name, color, number }) {
    const W = FACE_W, H = FACE_H;
    const brand = findBrand(name);
    const cat = brand?.cat || guessCategory(name);
    const c1 = color || brand?.c1 || hashColor(name);
    const c2 = brand?.c2 || mix(c1, "#000000", .35);
    const accent = brand?.accent || (luminance(c1) > .45 ? mix(c1, "#000000", .55) : mix(c1, "#ffffff", .55));
    const fg = luminance(c1) > .45 ? "#111114" : "#ffffff";
    const rnd = seeded((brand?.id || name || "x") + cat);
    const c = document.createElement("canvas");
    c.width = W; c.height = H;
    const x = c.getContext("2d");

    // sfondo
    const bg = x.createLinearGradient(0, 0, W, H);
    bg.addColorStop(0, mix(c1, "#ffffff", .14)); bg.addColorStop(.55, c1); bg.addColorStop(1, mix(c1, "#000000", .22));
    x.fillStyle = bg; x.fillRect(0, 0, W, H);

    // decorazione nello stile del negozio
    x.save();
    switch (brand?.deco || ["wave", "band"][Math.floor(rnd() * 2)]) {
      case "wave": {
        x.fillStyle = c2; x.globalAlpha = .9;
        x.beginPath(); x.moveTo(W * .5, H);
        x.bezierCurveTo(W * .66, H * .74, W * .78, H * .95, W, H * .45); x.lineTo(W, H); x.closePath(); x.fill();
        x.globalAlpha = .95; x.strokeStyle = accent; x.lineWidth = 7;
        x.beginPath(); x.moveTo(W * .44, H * 1.02);
        x.bezierCurveTo(W * .62, H * .68, W * .78, H * .9, W * 1.02, H * .36); x.stroke();
        break;
      }
      case "sun": {
        const g = x.createRadialGradient(W * .9, H * .12, 10, W * .9, H * .12, H * .78);
        g.addColorStop(0, accent); g.addColorStop(.45, c2); g.addColorStop(1, "rgba(0,0,0,0)");
        x.fillStyle = g; x.fillRect(0, 0, W, H);
        x.globalAlpha = .22; x.strokeStyle = accent; x.lineWidth = 6;
        for (let i = 0; i < 12; i++) {
          const a = Math.PI * (.5 + i / 11);
          x.beginPath(); x.moveTo(W * .9 + Math.cos(a) * H * .5, H * .12 + Math.sin(a) * H * .5);
          x.lineTo(W * .9 + Math.cos(a) * H * .78, H * .12 + Math.sin(a) * H * .78); x.stroke();
        }
        break;
      }
      case "circle": {
        x.fillStyle = c2; x.beginPath(); x.arc(W * .83, H * .2, H * .5, 0, Math.PI * 2); x.fill();
        x.fillStyle = accent; x.beginPath(); x.arc(W * .83, H * .2, H * .43, 0, Math.PI * 2); x.fill();
        x.globalAlpha = .12; x.fillStyle = "#fff"; x.beginPath(); x.arc(W * .05, H * 1.05, H * .5, 0, Math.PI * 2); x.fill();
        break;
      }
      case "band": {
        x.fillStyle = c2; x.fillRect(0, H * .7, W, H * .3);
        x.fillStyle = accent; x.fillRect(0, H * .7 - 12, W, 12);
        break;
      }
      case "stripes": {
        x.translate(W * .74, H); x.rotate(-Math.PI / 5.2);
        [[accent, 0], [c2, 70], [mix(accent, c2, .5), 140]].forEach(([col, off]) => { x.fillStyle = col; x.globalAlpha = .9; x.fillRect(-W, -off - 46, W * 2, 46); });
        break;
      }
      case "chevrons": {
        x.globalAlpha = .9;
        [[c2, 0], [accent, 1]].forEach(([col, i]) => {
          x.fillStyle = col; x.beginPath();
          const ox = W * (.66 + i * .12);
          x.moveTo(ox, H); x.lineTo(ox + W * .2, H * .55); x.lineTo(ox + W * .3, H * .55); x.lineTo(ox + W * .1, H); x.closePath(); x.fill();
        });
        break;
      }
    }
    x.restore();

    // disegni legati al tipo di negozio
    const icons = CAT_ICONS[cat] || CAT_ICONS.shop;
    x.save();
    x.strokeStyle = fg; x.globalAlpha = .17;
    const spots = [[.52, .2], [.66, .47], [.8, .2], [.93, .45], [.58, .75], [.75, .74], [.9, .82], [.45, .5]];
    spots.forEach(([px, py], i) => {
      const s = 70 + rnd() * 50;
      drawIcon(x, icons[(i + Math.floor(rnd() * 3)) % icons.length], W * px + (rnd() - .5) * 30, H * py + (rnd() - .5) * 26, s, (rnd() - .5) * .7);
    });
    x.restore();

    // riflesso lucido
    const gl = x.createRadialGradient(W * .2, -H * .25, 0, W * .2, -H * .25, W * .85);
    gl.addColorStop(0, "rgba(255,255,255,.22)"); gl.addColorStop(1, "rgba(255,255,255,0)");
    x.fillStyle = gl; x.fillRect(0, 0, W, H);

    // nome del negozio
    let label = (brand?.label || name || "Tessera").trim();
    if (brand?.transform === "lower") label = label.toLowerCase();
    if (brand?.transform === "upper") label = label.toUpperCase();
    const fam = FONTS[brand?.font || "sans"];
    const style = brand?.italic ? "italic " : "";
    const weight = brand?.weight || 800;
    let size = 128;
    const setFont = () => { x.font = `${style}${weight} ${size}px ${fam}`; };
    setFont();
    if ("letterSpacing" in x) x.letterSpacing = (brand?.tracking || 0) + "px";
    while (x.measureText(label).width > W * .6 && size > 46) { size -= 4; setFont(); }
    x.save();
    x.fillStyle = fg;
    x.shadowColor = fg === "#ffffff" ? "rgba(0,0,0,.22)" : "rgba(255,255,255,.25)";
    x.shadowBlur = 14; x.shadowOffsetY = 3;
    x.textBaseline = "alphabetic";
    x.fillText(label, 70, 62 + size * .86);
    x.restore();
    if ("letterSpacing" in x) x.letterSpacing = "4px";
    x.font = `700 32px ${FONTS.sans}`;
    x.fillStyle = fg; x.globalAlpha = .82;
    x.fillText((brand?.program || "Carta fedeltà").toUpperCase(), 73, 62 + size * .86 + 58);
    x.globalAlpha = 1;

    // numero della tessera
    if (number) {
      if ("letterSpacing" in x) x.letterSpacing = "3px";
      let ns = 46;
      x.font = `600 ${ns}px ui-monospace, "SF Mono", Menlo, Consolas, monospace`;
      while (x.measureText(number).width > W * .62 && ns > 26) { ns -= 2; x.font = `600 ${ns}px ui-monospace, "SF Mono", Menlo, Consolas, monospace`; }
      x.save();
      x.fillStyle = (brand?.deco === "band") ? "#ffffff" : fg;
      if (brand?.deco === "band" && luminance(c2) > .5) x.fillStyle = "#111114";
      x.shadowColor = "rgba(0,0,0,.25)"; x.shadowBlur = 6; x.shadowOffsetY = 2;
      x.fillText(number, 72, H - 62);
      x.restore();
    }
    if ("letterSpacing" in x) x.letterSpacing = "0px";

    // tassello di vetro con il simbolo del negozio
    const ts = 118, tx = W - 70 - ts, ty = H - 58 - ts;
    x.save();
    roundRect(x, tx, ty, ts, ts, 30);
    x.fillStyle = "rgba(255,255,255,.2)"; x.fill();
    const tg = x.createLinearGradient(0, ty, 0, ty + ts);
    tg.addColorStop(0, "rgba(255,255,255,.75)"); tg.addColorStop(.35, "rgba(255,255,255,.15)"); tg.addColorStop(1, "rgba(255,255,255,.4)");
    x.strokeStyle = tg; x.lineWidth = 3; x.stroke();
    x.strokeStyle = "#ffffff"; x.globalAlpha = .95;
    drawIcon(x, icons[0], tx + ts / 2, ty + ts / 2, 72);
    x.restore();
    return c;
  }
  const drawGeneratedFace = (name, color, number) => drawBrandFace({ name, color, number });

  /* ───────────── stato ───────────── */
  let cards = [];
  let openId = null;
  const urls = new Map(); // id -> objectURL dell'immagine
  const stackEl = $("#stack"), scroller = $("#scroller"), passEl = $("#pass");

  function imageURL(card) {
    let u = urls.get(card.id);
    if (!u && card.image) { u = URL.createObjectURL(card.image); urls.set(card.id, u); }
    return u || "";
  }
  function dropURL(id) { const u = urls.get(id); if (u) { URL.revokeObjectURL(u); urls.delete(id); } }
  /* look: "photo" = si vede la foto; "graphic" = grafica del negozio (la foto, se c'è, resta in card.photo) */
  function upgradeCard(c) {
    if (!c.look) c.look = c.generated ? "graphic" : "photo";
    if (c.photo === undefined) c.photo = null;
    return c;
  }
  const photoOf = (c) => (c.look === "photo" ? c.image : c.photo) || null;
  const numberOf = (code, display) => (display || prettyNumber(code) || "").trim();

  async function load() {
    try {
      cards = await DB.all();
    } catch (e) {
      cards = [];
      toast("Memoria non disponibile: le tessere non verranno salvate");
    }
    cards.forEach(upgradeCard);
    cards.sort((a, b) => (b.order ?? 0) - (a.order ?? 0));
    buildStack();
  }

  /* ───────────── pila delle tessere ───────────── */
  function visibleCards() {
    const q = $("#search").value.trim().toLowerCase();
    if (!q) return cards;
    return cards.filter((c) => (c.name || "").toLowerCase().includes(q) || (c.code || "").toLowerCase().includes(q) || (c.notes || "").toLowerCase().includes(q));
  }

  function buildStack() {
    stackEl.textContent = "";
    for (const card of cards) {
      const el = document.createElement("button");
      el.type = "button";
      el.className = "card";
      el.dataset.id = card.id;
      el.setAttribute("aria-label", "Apri " + (card.name || "tessera"));
      const face = document.createElement("div");
      face.className = "card-face";
      face.style.background = card.color || "#555";
      const img = document.createElement("img");
      img.alt = "";
      img.decoding = "async";
      img.src = imageURL(card);
      face.append(img);
      const tag = document.createElement("span");
      tag.className = "name-tag";
      tag.textContent = card.name || "";
      if (!card.name || card.look === "graphic") tag.hidden = true;
      face.append(tag);
      el.append(face);
      el.addEventListener("click", () => (openId === card.id ? closeCard() : openId ? closeCard() : openCard(card.id)));
      stackEl.append(el);
    }
    const n = cards.length;
    $("#countLabel").textContent = n ? (n === 1 ? "1 tessera" : n + " tessere") : "";
    $("#empty").hidden = n > 0;
    $("#footnote").hidden = n === 0;
    $("#searchBox").hidden = n < 4;
    layout();
  }

  function layout() {
    const W = stackEl.clientWidth || Math.min(innerWidth - 32, 440);
    const H = W / CARD_RATIO;
    const vis = visibleCards();
    const visIds = new Set(vis.map((c) => c.id));
    const els = $$(".card", stackEl);
    const peek = vis.length > 8 ? 54 : PEEK;

    if (!openId) {
      let i = 0;
      for (const el of els) {
        const shown = visIds.has(el.dataset.id);
        el.classList.toggle("dimmed", !shown);
        el.classList.remove("selected");
        el.style.zIndex = shown ? i + 1 : 0;
        el.style.transform = `translate3d(0, ${shown ? i * peek : i * peek}px, 0)`;
        el.tabIndex = shown ? 0 : -1;
        if (shown) i++;
      }
      stackEl.style.height = vis.length ? (vis.length - 1) * peek + H + "px" : "0px";
      return;
    }

    // tessera aperta: in alto; le altre raccolte in fondo allo schermo
    const stackTop = stackEl.getBoundingClientRect().top;
    const targetTop = safeTop() + 60;
    const vh = innerHeight;
    const others = els.filter((el) => el.dataset.id !== openId && visIds.has(el.dataset.id));
    const shownOthers = Math.min(others.length, 4);
    const bottomBase = vh - safeBottom() - 14 - shownOthers * 9;
    let k = 0;
    for (const el of els) {
      el.tabIndex = -1;
      if (el.dataset.id === openId) {
        el.classList.add("selected");
        el.classList.remove("dimmed");
        el.style.zIndex = 50;
        el.style.transform = `translate3d(0, ${targetTop - stackTop}px, 0)`;
        el.tabIndex = 0;
      } else if (visIds.has(el.dataset.id)) {
        const j = Math.min(k, 3);
        el.classList.remove("selected", "dimmed");
        el.style.zIndex = 10 + k;
        const scale = .9 + j * .02;
        el.style.transform = `translate3d(0, ${bottomBase + j * 9 - stackTop}px, 0) scale(${scale})`;
        k++;
      } else {
        el.classList.add("dimmed");
      }
    }
    // pannello del codice sotto la tessera aperta
    passEl.style.top = targetTop + H + 14 + "px";
    passEl.style.maxHeight = Math.max(200, bottomBase - (targetTop + H + 14) - 14) + "px";
  }
  let _st = null, _sb = null;
  function measureSafe() {
    const p = document.createElement("div");
    p.style.cssText = "position:fixed;top:0;left:0;padding-top:env(safe-area-inset-top);padding-bottom:env(safe-area-inset-bottom);visibility:hidden";
    document.body.append(p);
    const cs = getComputedStyle(p);
    _st = parseFloat(cs.paddingTop) || 0; _sb = parseFloat(cs.paddingBottom) || 0;
    p.remove();
  }
  const safeTop = () => (_st == null && measureSafe(), _st);
  const safeBottom = () => (_sb == null && measureSafe(), _sb);

  async function openCard(id) {
    const card = cards.find((c) => c.id === id);
    if (!card) return;
    openId = id;
    document.body.classList.add("open");
    $("#ambient img").src = imageURL(card);
    fillPass(card);
    passEl.hidden = false;
    layout();
    requestAnimationFrame(() => passEl.classList.add("show"));
    try { history.pushState({ card: id }, ""); } catch { /* niente */ }
    card.lastUsed = Date.now();
    DB.put(card).catch(() => {});
  }
  function closeCard(fromHistory) {
    if (!openId) return;
    openId = null;
    document.body.classList.remove("open");
    passEl.classList.remove("show");
    setTimeout(() => { if (!openId) passEl.hidden = true; }, 380);
    layout();
    if (!fromHistory && history.state && history.state.card) { try { history.back(); } catch { /* niente */ } }
  }
  addEventListener("popstate", () => { if (openId) closeCard(true); });

  function fillPass(card) {
    const color = card.color || "#3a3a3c";
    const [r, g, b] = hexRgb(color);
    passEl.style.setProperty("--pass-tint", `rgba(${r},${g},${b},.62)`);
    passEl.style.setProperty("--pass-tint-2", `rgba(${r},${g},${b},.42)`);
    passEl.style.setProperty("--pass-text", textOn(color));
    $("#passName").textContent = card.name || "Tessera";
    $("#passNumber").textContent = card.display || prettyNumber(card.code);
    $("#passNotes").textContent = card.notes || "";
    renderCode($("#codeBox"), card.code, card.format);
    $("#fullBtn").hidden = !card.code;
    $("#passHint").hidden = !card.code;
  }

  /* codice a schermo intero */
  let wakeLock = null;
  async function showFull() {
    const card = cards.find((c) => c.id === openId);
    if (!card || !card.code) return;
    $("#fullThumb").src = imageURL(card);
    $("#fullName").textContent = card.name || "";
    $("#fullNumber").textContent = card.display || prettyNumber(card.code);
    await renderCode($("#fullBox"), card.code, card.format);
    $("#fullcode").hidden = false;
    try { wakeLock = await navigator.wakeLock?.request("screen"); } catch { /* niente */ }
  }
  function hideFull() {
    $("#fullcode").hidden = true;
    try { wakeLock?.release(); } catch { /* niente */ }
    wakeLock = null;
  }

  /* ───────────── avvisi, fogli, menu ───────────── */
  let toastTimer = null;
  function toast(msg) {
    const t = $("#toast");
    t.textContent = msg;
    t.hidden = false;
    t.style.animation = "none"; void t.offsetWidth; t.style.animation = "";
    clearTimeout(toastTimer);
    toastTimer = setTimeout(() => { t.hidden = true; }, 2600);
  }
  function openSheet(el) { el.hidden = false; }
  function closeSheet(el) { el.hidden = true; }
  $$("[data-close]").forEach((d) => d.addEventListener("click", () => closeSheet(d.parentElement)));

  /* riflesso del vetro sotto il dito */
  document.addEventListener("pointerdown", (e) => {
    const g = e.target.closest?.(".glass");
    if (!g) return;
    const r = g.getBoundingClientRect();
    g.style.setProperty("--mx", e.clientX - r.left + "px");
    g.style.setProperty("--my", e.clientY - r.top + "px");
    g.classList.add("lit");
    const off = () => { g.classList.remove("lit"); removeEventListener("pointerup", off); removeEventListener("pointercancel", off); };
    addEventListener("pointerup", off); addEventListener("pointercancel", off);
  }, { passive: true });

  /* ───────────── aggiunta: scelta della foto ───────────── */
  let pickPurpose = "new"; // "new" | "replace"
  function pick(kind, purpose = "new") {
    pickPurpose = purpose;
    const input = kind === "camera" ? $("#fileCamera") : $("#fileLibrary");
    input.value = "";
    input.click();
  }
  $$("[data-pick]").forEach((b) => b.addEventListener("click", () => {
    const sheet = $("#addSheet");
    const replace = !!b.closest("#addSheet") && sheet.dataset.mode === "replace";
    closeSheet(sheet);
    pick(b.dataset.pick, replace ? "replace" : "new");
  }));
  [$("#fileCamera"), $("#fileLibrary")].forEach((inp) => inp.addEventListener("change", () => {
    const f = inp.files && inp.files[0];
    if (f) startEditor(f);
  }));

  /* ───────────── editor di ritaglio ───────────── */
  const ed = {
    src: null, quad: null, auto: null, rot: 0, view: { s: 1, ox: 0, oy: 0 }, scan: null, scanToken: 0,
  };
  const cropArea = $("#cropArea"), cropCanvas = $("#cropCanvas");

  async function startEditor(file) {
    let loaded;
    try { loaded = await loadImageFile(file); } catch { toast("Non riesco ad aprire questa immagine"); return; }
    ed.src = toCanvas(loaded.img, 2400);
    URL.revokeObjectURL(loaded.url);
    ed.rot = 0;
    try { ed.auto = detectCard(ed.src); } catch (e) { ed.auto = null; console.warn(e); }
    if (ed.auto) {
      // stringo appena verso l'interno: niente bordini di sfondo sugli spigoli
      const cx = ed.auto.reduce((t, p) => t + p[0], 0) / 4, cy = ed.auto.reduce((t, p) => t + p[1], 0) / 4;
      ed.auto = ed.auto.map(([x, y]) => [cx + (x - cx) * .985, cy + (y - cy) * .985]);
    }
    ed.quad = ed.auto ? ed.auto.map((p) => [...p]) : defaultQuad();
    $("#editorHint").textContent = ed.auto
      ? "Ho trovato la tessera: controlla gli angoli"
      : "Trascina i quattro angoli sui bordi della tessera";
    $("#editor").hidden = false;
    requestAnimationFrame(() => { fitEditor(); drawEditor(); });
    // cerco subito il codice in tutta l'immagine
    setScanChip("busy", "Cerco il codice…");
    const token = ++ed.scanToken;
    ed.scan = null;
    const found = await scanCanvas(ed.src);
    if (token !== ed.scanToken) return;
    ed.scan = found;
    if (found.length) setScanChip("ok", "Codice trovato · " + (FORMAT_LABEL[found[0].format] || found[0].format));
    else setScanChip("none", "Codice non trovato: potrai inserirlo dopo");
  }
  function setScanChip(state, text) {
    const c = $("#scanChip");
    c.classList.remove("ok", "none", "busy");
    c.classList.add(state);
    $("#scanText").textContent = (state === "ok" ? "✓ " : "") + text;
  }
  function defaultQuad() {
    const W = ed.src.width, H = ed.src.height;
    let w, h;
    if (W / H > CARD_RATIO) { h = H * .78; w = h * CARD_RATIO; } else { w = W * .86; h = w / CARD_RATIO; }
    if (h > H * .9) { h = H * .9; w = h * CARD_RATIO; }
    const x = (W - w) / 2, y = (H - h) / 2;
    return [[x, y], [x + w, y], [x + w, y + h], [x, y + h]];
  }
  function fullQuad() {
    const W = ed.src.width, H = ed.src.height;
    return [[0, 0], [W, 0], [W, H], [0, H]];
  }
  function fitEditor() {
    const r = cropArea.getBoundingClientRect();
    const pad = 22;
    const s = Math.min((r.width - pad * 2) / ed.src.width, (r.height - pad * 2) / ed.src.height);
    const w = ed.src.width * s, h = ed.src.height * s;
    ed.view = { s, ox: (r.width - w) / 2, oy: (r.height - h) / 2 };
    const dpr = Math.min(devicePixelRatio || 1, 3);
    cropCanvas.width = Math.round(w * dpr); cropCanvas.height = Math.round(h * dpr);
    cropCanvas.style.width = w + "px"; cropCanvas.style.height = h + "px";
    cropCanvas.style.left = ed.view.ox + "px"; cropCanvas.style.top = ed.view.oy + "px";
    const x = cropCanvas.getContext("2d");
    x.imageSmoothingQuality = "high";
    x.drawImage(ed.src, 0, 0, cropCanvas.width, cropCanvas.height);
    $("#cropSvg").setAttribute("viewBox", `0 0 ${r.width} ${r.height}`);
  }
  const toView = ([x, y]) => [ed.view.ox + x * ed.view.s, ed.view.oy + y * ed.view.s];
  const toImg = (vx, vy) => [(vx - ed.view.ox) / ed.view.s, (vy - ed.view.oy) / ed.view.s];

  function orderedQuad() {
    const q = ed.quad, r = ed.rot;
    return [q[r % 4], q[(r + 1) % 4], q[(r + 2) % 4], q[(r + 3) % 4]];
  }
  let previewTimer = null;
  function drawEditor() {
    if (!ed.src) return;
    const r = cropArea.getBoundingClientRect();
    const pts = ed.quad.map(toView);
    const poly = pts.map((p) => p.join(",")).join(" ");
    $("#cropLine").setAttribute("points", poly);
    $("#cropMask").setAttribute("d", `M0 0H${r.width}V${r.height}H0Z M${pts.map((p) => p.join(" ")).join(" L")} Z`);
    const oq = orderedQuad().map(toView);
    const top = $("#cropTopEdge");
    top.setAttribute("x1", oq[0][0]); top.setAttribute("y1", oq[0][1]);
    top.setAttribute("x2", oq[1][0]); top.setAttribute("y2", oq[1][1]);
    $$(".handle", cropArea).forEach((h, i) => { h.style.left = pts[i][0] + "px"; h.style.top = pts[i][1] + "px"; });
    clearTimeout(previewTimer);
    previewTimer = setTimeout(drawPreview, 60);
  }
  function drawPreview() {
    const pc = $("#cropPreview");
    const small = warp(ed.src, orderedQuad(), pc.width, pc.height);
    pc.getContext("2d").drawImage(small, 0, 0);
  }

  // trascinamento degli angoli, con lente d'ingrandimento
  const loupe = $("#loupe");
  $$(".handle", cropArea).forEach((h) => {
    let id = null, dx = 0, dy = 0;
    h.addEventListener("pointerdown", (e) => {
      e.preventDefault();
      id = e.pointerId;
      h.setPointerCapture(id);
      h.classList.add("drag");
      const i = +h.dataset.i;
      const [vx, vy] = toView(ed.quad[i]);
      const r = cropArea.getBoundingClientRect();
      dx = vx - (e.clientX - r.left); dy = vy - (e.clientY - r.top);
      showLoupe(i);
    });
    h.addEventListener("pointermove", (e) => {
      if (e.pointerId !== id) return;
      const r = cropArea.getBoundingClientRect();
      const i = +h.dataset.i;
      let [x, y] = toImg(e.clientX - r.left + dx, e.clientY - r.top + dy);
      x = Math.max(0, Math.min(ed.src.width, x));
      y = Math.max(0, Math.min(ed.src.height, y));
      ed.quad[i] = [x, y];
      drawEditor();
      showLoupe(i);
    });
    const end = (e) => {
      if (e.pointerId !== id) return;
      id = null;
      h.classList.remove("drag");
      loupe.style.display = "none";
    };
    h.addEventListener("pointerup", end);
    h.addEventListener("pointercancel", end);
  });
  function showLoupe(i) {
    const [vx, vy] = toView(ed.quad[i]);
    const size = 120, zoom = 2.6;
    const x = loupe.getContext("2d");
    const lw = loupe.width, lh = loupe.height;
    const span = size / zoom / ed.view.s; // pixel immagine visibili
    const [ix, iy] = ed.quad[i];
    x.fillStyle = "#000"; x.fillRect(0, 0, lw, lh);
    x.imageSmoothingQuality = "high";
    x.drawImage(ed.src, ix - span / 2, iy - span / 2, span, span, 0, 0, lw, lh);
    x.strokeStyle = "rgba(255,214,10,.95)"; x.lineWidth = 3;
    x.beginPath(); x.moveTo(lw / 2, lh / 2 - 22); x.lineTo(lw / 2, lh / 2 + 22); x.moveTo(lw / 2 - 22, lh / 2); x.lineTo(lw / 2 + 22, lh / 2); x.stroke();
    loupe.style.display = "block";
    const above = vy - size - 46 > 0;
    loupe.style.left = Math.max(0, Math.min(cropArea.clientWidth - size, vx - size / 2)) + "px";
    loupe.style.top = (above ? vy - size - 46 : vy + 46) + "px";
  }

  $("#cropFull").addEventListener("click", () => { ed.quad = fullQuad(); drawEditor(); });
  $("#cropReset").addEventListener("click", () => { ed.quad = ed.auto ? ed.auto.map((p) => [...p]) : defaultQuad(); ed.rot = 0; drawEditor(); });
  $("#cropRotate").addEventListener("click", () => { ed.rot = (ed.rot + 1) % 4; drawEditor(); });
  $("#cropCancel").addEventListener("click", () => { $("#editor").hidden = true; ed.src = null; ed.scanToken++; });
  addEventListener("resize", () => {
    _st = _sb = null;
    if (!$("#editor").hidden && ed.src) { fitEditor(); drawEditor(); }
    layout();
  });

  $("#cropNext").addEventListener("click", async () => {
    const btn = $("#cropNext");
    btn.disabled = true;
    try {
      const face = warp(ed.src, orderedQuad(), FACE_W, FACE_H);
      const blob = await canvasBlob(face, "image/jpeg", .9);
      // se il codice non è ancora stato trovato, riprovo sulla tessera raddrizzata
      let found = ed.scan;
      if (!found) found = await scanCanvas(ed.src);
      if (!found.length) found = await scanCanvas(face);
      const color = dominantColor(face);
      const palette = paletteFrom(face);
      $("#editor").hidden = true;
      if (pickPurpose === "replace" && draft) {
        draft.photo = blob; draft.look = "photo"; draft.lookTouched = true; draft.palette = palette;
        const hadCode = !!f.code.value.trim();
        if (!hadCode && found.length) applyScan(found[0]);
        if (!draft.colorTouched) draft.color = color;
        showDraftImage();
        fillDraftColor();
        if (found.length && !hadCode) scanMsg("ok", "✓ Codice letto dall'immagine");
        renderDraftCode();
      } else {
        openDetails({ photo: blob, color, palette }, found);
      }
      ed.src = null;
    } finally {
      btn.disabled = false;
    }
  });

  /* ───────────── dettagli (nuova o modifica) ───────────── */
  let draft = null;
  const f = { name: $("#fName"), code: $("#fCode"), format: $("#fFormat"), display: $("#fDisplay"), color: $("#fColor"), notes: $("#fNotes") };

  function openDetails(base, found = [], existing = null) {
    draft = {
      id: existing?.id || null,
      name: existing?.name || "",
      code: existing?.code || "",
      format: existing?.format || "auto",
      formatTouched: !!existing,
      display: existing?.display || "",
      color: existing?.color || base.color || "#2c6cf6",
      notes: existing?.notes || "",
      photo: existing ? photoOf(existing) : base.photo || null,
      look: existing ? existing.look : base.photo ? "photo" : "graphic",
      lookTouched: !!existing,
      palette: base.palette || existing?.palette || [],
      colorTouched: !!existing,
      order: existing?.order,
      createdAt: existing?.createdAt,
    };
    $("#detTitle").textContent = existing ? "Modifica tessera" : "Nuova tessera";
    f.name.value = draft.name;
    f.code.value = draft.code;
    f.format.value = draft.format;
    f.display.value = draft.display;
    f.notes.value = draft.notes;
    scanMsg("", "");
    if (!existing && found.length) {
      applyScan(found[0]);
      scanMsg("ok", "✓ Codice letto: " + (FORMAT_LABEL[draft.format] || draft.format));
    } else if (!existing) {
      scanMsg("", draft.photo ? "Nessun codice trovato nell'immagine: inquadralo o digitalo" : "Digita il numero della tessera o inquadra il codice");
    }
    updateBrand(false);
    fillDraftColor();
    showDraftImage();
    renderDraftCode();
    $("#details").hidden = false;
    $(".details-scroll").scrollTop = 0;
    if (!existing && !draft.name) setTimeout(() => { if (!matchMedia("(pointer: coarse)").matches) f.name.focus(); }, 350);
  }
  function applyScan(r) {
    draft.code = r.text;
    draft.format = r.format;
    draft.formatTouched = true;
    f.code.value = r.text;
    f.format.value = r.format;
  }
  function scanMsg(kind, text) {
    const m = $("#scanMsg");
    m.className = "scan-msg" + (kind ? " " + kind : "");
    m.textContent = text;
  }
  let draftURL = null;
  function showDraftImage() {
    if (draftURL) URL.revokeObjectURL(draftURL);
    draftURL = null;
    const img = $("#detImg");
    if (draft.look === "graphic" || !draft.photo) {
      const c = drawBrandFace({ name: f.name.value || "Tessera", color: draft.color, number: numberOf(f.code.value, f.display.value) });
      img.src = c.toDataURL("image/jpeg", .85);
    } else {
      draftURL = URL.createObjectURL(draft.photo);
      img.src = draftURL;
    }
    $("#detFace").style.background = draft.color;
    $("#details").style.setProperty("--det-bg", draft.color);
    $("#detChangeImg").textContent = draft.photo ? "Cambia foto" : "Aggiungi foto";
    $$("#lookSeg button").forEach((b) => {
      const on = b.dataset.look === (draft.photo ? draft.look : "graphic");
      b.classList.toggle("on", on);
      b.setAttribute("aria-pressed", String(on));
      if (b.dataset.look === "photo") b.disabled = !draft.photo;
    });
  }
  /* riconosce il negozio dal nome (o dalle note) e propone la sua grafica */
  function updateBrand(fromTyping) {
    const brand = findBrand(f.name.value, f.notes.value);
    const hint = $("#brandHint");
    if (brand) {
      hint.textContent = "Negozio riconosciuto: " + brand.label.replace(/^la/, "") + " · grafica con i suoi colori";
      hint.className = "brand-hint ok";
    } else {
      hint.textContent = draft.look === "graphic" && f.name.value.trim() ? "Grafica creata dal nome del negozio" : "";
      hint.className = "brand-hint";
    }
    if (fromTyping && !draft.lookTouched && brand) draft.look = "graphic";
    if (brand && draft.look === "graphic" && !draft.colorTouched) draft.color = brand.c1;
    if (fromTyping && !draft.colorTouched && !brand && !draft.photo) draft.color = hashColor(f.name.value.trim().toLowerCase());
    return brand;
  }
  function setLook(look) {
    if (look === "photo" && !draft.photo) return;
    draft.look = look;
    draft.lookTouched = true;
    if (look === "graphic") {
      const brand = findBrand(f.name.value, f.notes.value);
      if (brand) { draft.color = brand.c1; draft.colorTouched = false; }
    }
    updateBrand(false);
    fillDraftColor();
    showDraftImage();
  }
  $$("#lookSeg button").forEach((b) => b.addEventListener("click", () => setLook(b.dataset.look)));
  const PRESET = ["#e30613", "#ff8a00", "#ffcc00", "#00a650", "#0a84ff", "#5e2ca5", "#1c1c1e"];
  function fillDraftColor() {
    const sw = $("#swatches");
    sw.textContent = "";
    const list = [...new Set([...(draft.palette || []).slice(0, 3), ...PRESET])].slice(0, draft.palette?.length ? 5 : 6);
    if (!list.includes(draft.color)) list.unshift(draft.color);
    for (const col of list.slice(0, 6)) {
      const b = document.createElement("button");
      b.type = "button";
      b.className = "swatch" + (col.toLowerCase() === draft.color.toLowerCase() ? " on" : "");
      b.style.background = col;
      b.setAttribute("aria-label", "Colore " + col);
      b.addEventListener("click", () => { draft.color = col; draft.colorTouched = true; f.color.value = col; fillDraftColor(); showDraftImage(); });
      sw.append(b);
    }
    f.color.value = draft.color;
  }
  f.color.addEventListener("input", () => { draft.color = f.color.value; draft.colorTouched = true; fillDraftColor(); showDraftImage(); });

  let codeTimer = null;
  function effectiveFormat() {
    const v = f.format.value;
    return v === "auto" ? guessFormat(f.code.value) : v;
  }
  async function renderDraftCode() {
    const box = $("#codePreview");
    const code = f.code.value.trim();
    const fmt = effectiveFormat();
    if (!code || fmt === "none") { box.hidden = true; return; }
    box.hidden = false;
    const ok = await renderCode(box, code, fmt);
    if (!ok) {
      scanMsg("err", `Il codice non è valido per ${FORMAT_LABEL[fmt] || fmt}. Prova "Code 128" o "QR code".`);
    } else if ($("#scanMsg").classList.contains("err")) {
      scanMsg("", "");
    }
    f.display.placeholder = prettyNumber(code) || "Uguale al codice";
  }
  f.code.addEventListener("input", () => { clearTimeout(codeTimer); codeTimer = setTimeout(renderDraftCode, 180); });
  f.format.addEventListener("change", () => { draft.formatTouched = true; renderDraftCode(); });
  let faceTimer = null;
  const refreshFace = (typing) => {
    clearTimeout(faceTimer);
    faceTimer = setTimeout(() => { if (!draft) return; updateBrand(typing); fillDraftColor(); showDraftImage(); }, 160);
  };
  f.name.addEventListener("input", () => refreshFace(true));
  f.notes.addEventListener("input", () => refreshFace(true));
  [f.code, f.display].forEach((i) => i.addEventListener("input", () => { if (draft?.look === "graphic" || !draft?.photo) refreshFace(false); }));
  [f.name, f.code, f.display, f.notes].forEach((inp) => inp.addEventListener("keydown", (e) => {
    if (e.key === "Enter") { e.preventDefault(); const order = [f.name, f.code, f.display]; const i = order.indexOf(inp); if (i >= 0 && i < order.length - 1) order[i + 1].focus(); else inp.blur(); }
  }));

  $("#detCancel").addEventListener("click", () => { $("#details").hidden = true; draft = null; });
  $("#detChangeImg").addEventListener("click", () => openPickChoice());
  function openPickChoice() {
    // riuso il foglio "nuova tessera" ma per sostituire l'immagine
    const sheet = $("#addSheet");
    sheet.dataset.mode = "replace";
    $("#addTitle").textContent = "Immagine della tessera";
    $("#manualBtn").hidden = true;
    openSheet(sheet);
  }
  function resetAddSheet() {
    const sheet = $("#addSheet");
    sheet.dataset.mode = "new";
    $("#addTitle").textContent = "Nuova tessera";
    $("#manualBtn").hidden = false;
  }

  $("#detSave").addEventListener("click", async () => {
    const name = f.name.value.trim();
    const code = f.code.value.trim();
    if (!name) { f.name.focus(); toast("Scrivi il nome della tessera"); return; }
    const format = code ? effectiveFormat() : "none";
    if (code && format !== "none") {
      try { await barcodeSVG(code, format); } catch { toast("Il codice non è valido per il tipo scelto"); return; }
    }
    const display = f.display.value.trim();
    const look = draft.photo ? draft.look : "graphic";
    const image = look === "photo" ? draft.photo
      : await canvasBlob(drawBrandFace({ name, color: draft.color, number: numberOf(code, display) }), "image/jpeg", .9);
    const now = Date.now();
    const card = {
      id: draft.id || (crypto.randomUUID ? crypto.randomUUID() : String(now) + Math.random().toString(16).slice(2)),
      name, code, format, display,
      color: draft.color,
      notes: f.notes.value.trim(),
      image,
      look,
      photo: look === "graphic" ? draft.photo : null,
      generated: look === "graphic",
      palette: draft.palette || [],
      order: draft.order ?? (cards.reduce((m, c) => Math.max(m, c.order ?? 0), 0) + 1),
      createdAt: draft.createdAt || now,
      updatedAt: now,
    };
    try {
      await DB.put(card);
    } catch (e) {
      toast("Salvataggio non riuscito: spazio esaurito?");
      return;
    }
    dropURL(card.id);
    const i = cards.findIndex((c) => c.id === card.id);
    if (i >= 0) cards[i] = card; else cards.unshift(card);
    cards.sort((a, b) => (b.order ?? 0) - (a.order ?? 0));
    const wasOpen = openId === card.id;
    $("#details").hidden = true;
    draft = null;
    buildStack();
    if (wasOpen) { $("#ambient img").src = imageURL(card); fillPass(card); layout(); }
    else { scroller.scrollTo({ top: 0, behavior: "smooth" }); toast(i >= 0 ? "Tessera aggiornata" : "Tessera aggiunta"); }
    navigator.storage?.persist?.().catch(() => {});
  });

  /* lettura del codice da un'altra immagine (es. il retro della tessera) */
  $("#photoScanBtn").addEventListener("click", () => { $("#fileScan").value = ""; $("#fileScan").click(); });
  $("#fileScan").addEventListener("change", async () => {
    const file = $("#fileScan").files?.[0];
    if (!file) return;
    scanMsg("", "Cerco il codice…");
    try {
      const { img, url } = await loadImageFile(file);
      const c = toCanvas(img, 2400);
      URL.revokeObjectURL(url);
      const found = await scanCanvas(c);
      if (found.length) {
        applyScan(found[0]);
        scanMsg("ok", "✓ Codice letto: " + (FORMAT_LABEL[found[0].format] || found[0].format));
        renderDraftCode();
      } else {
        scanMsg("err", "Nessun codice trovato in questa immagine");
      }
    } catch {
      scanMsg("err", "Non riesco ad aprire questa immagine");
    }
  });

  /* inquadratura dal vivo con la fotocamera */
  let liveStream = null, liveRun = false;
  $("#liveScanBtn").addEventListener("click", startLive);
  $("#liveClose").addEventListener("click", stopLive);
  async function startLive() {
    if (!navigator.mediaDevices?.getUserMedia) { toast("Fotocamera non disponibile"); return; }
    try {
      liveStream = await navigator.mediaDevices.getUserMedia({ video: { facingMode: { ideal: "environment" }, width: { ideal: 1920 }, height: { ideal: 1080 } }, audio: false });
    } catch {
      toast("Permesso fotocamera negato");
      return;
    }
    const v = $("#liveVideo");
    v.srcObject = liveStream;
    $("#live").hidden = false;
    try { await v.play(); } catch { /* niente */ }
    liveRun = true;
    const c = document.createElement("canvas");
    const loop = async () => {
      if (!liveRun) return;
      if (v.videoWidth) {
        // analizzo la zona centrale, dove c'è la cornice
        const vw = v.videoWidth, vh = v.videoHeight;
        const cw = Math.round(vw * .8), ch = Math.round(vh * .6);
        c.width = Math.min(cw, 1280); c.height = Math.round(c.width * ch / cw);
        c.getContext("2d", { willReadFrequently: true }).drawImage(v, (vw - cw) / 2, (vh - ch) / 2, cw, ch, 0, 0, c.width, c.height);
        const found = await scanCanvas(c, false);
        if (found.length && liveRun) {
          stopLive();
          applyScan(found[0]);
          scanMsg("ok", "✓ Codice letto: " + (FORMAT_LABEL[found[0].format] || found[0].format));
          renderDraftCode();
          navigator.vibrate?.(30);
          return;
        }
      }
      setTimeout(loop, 120);
    };
    loop();
  }
  function stopLive() {
    liveRun = false;
    liveStream?.getTracks().forEach((t) => t.stop());
    liveStream = null;
    $("#live").hidden = true;
  }

  /* ───────────── pulsanti principali ───────────── */
  $("#addBtn").addEventListener("click", () => { resetAddSheet(); openSheet($("#addSheet")); });
  $("#manualBtn").addEventListener("click", () => {
    closeSheet($("#addSheet"));
    const color = PRESET[Math.floor(Math.random() * 6)];
    openDetails({ photo: null, color, palette: [] });
  });
  $("#doneBtn").addEventListener("click", () => closeCard());
  $("#codeBox").addEventListener("click", showFull);
  $("#fullBtn").addEventListener("click", showFull);
  $("#closeFull").addEventListener("click", hideFull);
  $("#fullcode").addEventListener("click", (e) => { if (e.target === $("#fullcode")) hideFull(); });
  $("#cardMenuBtn").addEventListener("click", () => openSheet($("#cardMenu")));
  $$("#cardMenu [role=menuitem]").forEach((b) => b.addEventListener("click", () => closeSheet($("#cardMenu")), true));
  $("#topBtn").addEventListener("click", async () => {
    const card = cards.find((c) => c.id === openId);
    if (!card) return;
    card.order = cards.reduce((m, c) => Math.max(m, c.order ?? 0), 0) + 1;
    await DB.put(card).catch(() => {});
    cards.sort((a, b) => (b.order ?? 0) - (a.order ?? 0));
    closeCard();
    setTimeout(() => { buildStack(); toast("Spostata in cima"); }, 350);
  });
  $("#editBtn").addEventListener("click", () => {
    const card = cards.find((c) => c.id === openId);
    if (card) openDetails({}, [], card);
  });
  $("#deleteBtn").addEventListener("click", async () => {
    const card = cards.find((c) => c.id === openId);
    if (!card) return;
    if (!confirm(`Eliminare la tessera "${card.name || "senza nome"}"?`)) return;
    await DB.del(card.id).catch(() => {});
    closeCard();
    cards = cards.filter((c) => c.id !== card.id);
    setTimeout(() => { dropURL(card.id); buildStack(); toast("Tessera eliminata"); }, 300);
  });
  // tocco sullo sfondo con tessera aperta: chiude
  document.addEventListener("click", (e) => {
    if (!openId) return;
    if (e.target.closest(".card, .pass, .topbar, .fullcode, .details, .sheet-wrap, .menu-wrap, .editor, .live, .toast")) return;
    closeCard();
  });
  $("#search").addEventListener("input", () => layout());
  document.addEventListener("keydown", (e) => {
    if (e.key !== "Escape") return;
    if (!$("#fullcode").hidden) hideFull();
    else if (!$("#live").hidden) stopLive();
    else if (!$("#menu").hidden) closeSheet($("#menu"));
    else if (!$("#cardMenu").hidden) closeSheet($("#cardMenu"));
    else if (!$("#addSheet").hidden) closeSheet($("#addSheet"));
    else if (openId) closeCard();
  });

  /* menu */
  $("#menuBtn").addEventListener("click", () => openSheet($("#menu")));
  const namesBtn = $("#namesBtn");
  function applyNames() {
    const on = settings.get("names", false);
    document.body.classList.toggle("no-names", !on);
    namesBtn.setAttribute("aria-checked", String(on));
  }
  namesBtn.addEventListener("click", () => { settings.set("names", !settings.get("names", false)); applyNames(); });
  applyNames();

  $("#exportBtn").addEventListener("click", async () => {
    closeSheet($("#menu"));
    if (!cards.length) { toast("Non ci sono tessere da salvare"); return; }
    const out = { app: "tessere", version: 2, exportedAt: new Date().toISOString(), cards: [] };
    for (const c of cards) {
      const { image, photo, ...rest } = c;
      out.cards.push({ ...rest, image: image ? await blobToDataURL(image) : null, photo: photo ? await blobToDataURL(photo) : null });
    }
    const name = `tessere-backup-${new Date().toISOString().slice(0, 10)}.json`;
    const file = new File([JSON.stringify(out)], name, { type: "application/json" });
    if (navigator.canShare?.({ files: [file] })) {
      try { await navigator.share({ files: [file], title: "Backup tessere" }); return; } catch (e) { if (e.name === "AbortError") return; }
    }
    const a = document.createElement("a");
    a.href = URL.createObjectURL(file);
    a.download = name;
    document.body.append(a); a.click(); a.remove();
    setTimeout(() => URL.revokeObjectURL(a.href), 4000);
  });
  /* grafica dei negozi per tutte le tessere riconosciute (le foto restano salvate) */
  $("#brandAllBtn").addEventListener("click", async () => {
    closeSheet($("#menu"));
    const todo = cards.filter((c) => c.look === "photo" && findBrand(c.name, c.notes));
    if (!todo.length) {
      toast(cards.some((c) => findBrand(c.name, c.notes)) ? "Le tessere riconosciute hanno già la grafica" : "Nessun negozio riconosciuto tra le tessere");
      return;
    }
    const names = todo.map((c) => c.name).join(", ");
    if (!confirm(`Creo la grafica del negozio per: ${names}?\n\nLe foto restano salvate: puoi tornare alla foto da Modifica.`)) return;
    for (const c of todo) {
      const brand = findBrand(c.name, c.notes);
      c.photo = c.image;
      c.look = "graphic";
      c.generated = true;
      c.color = brand.c1;
      c.image = await canvasBlob(drawBrandFace({ name: c.name, color: c.color, number: numberOf(c.code, c.display) }), "image/jpeg", .9);
      c.updatedAt = Date.now();
      await DB.put(c).catch(() => {});
      dropURL(c.id);
    }
    buildStack();
    toast(todo.length === 1 ? "Grafica creata per 1 tessera" : `Grafica creata per ${todo.length} tessere`);
  });
  $("#importBtn").addEventListener("click", () => { closeSheet($("#menu")); $("#fileImport").value = ""; $("#fileImport").click(); });
  $("#fileImport").addEventListener("change", async () => {
    const file = $("#fileImport").files?.[0];
    if (!file) return;
    try {
      const data = JSON.parse(await file.text());
      if (!data || !Array.isArray(data.cards)) throw new Error("formato");
      let n = 0;
      for (const c of data.cards) {
        if (!c || typeof c.id !== "string") continue;
        const card = {
          id: c.id, name: String(c.name || ""), code: String(c.code || ""), format: String(c.format || "none"),
          display: String(c.display || ""), color: /^#[0-9a-f]{6}$/i.test(c.color) ? c.color : "#3a3a3c",
          notes: String(c.notes || ""), generated: !!c.generated, palette: Array.isArray(c.palette) ? c.palette.filter((p) => /^#[0-9a-f]{6}$/i.test(p)) : [],
          order: Number(c.order) || 0, createdAt: Number(c.createdAt) || Date.now(), updatedAt: Number(c.updatedAt) || Date.now(),
          image: typeof c.image === "string" && c.image.startsWith("data:image/") ? await dataURLToBlob(c.image) : null,
          photo: typeof c.photo === "string" && c.photo.startsWith("data:image/") ? await dataURLToBlob(c.photo) : null,
          look: c.look === "photo" || c.look === "graphic" ? c.look : undefined,
        };
        upgradeCard(card);
        if (!card.image) { card.look = "graphic"; card.generated = true; card.image = await canvasBlob(drawGeneratedFace(card.name, card.color, numberOf(card.code, card.display)), "image/jpeg", .9); }
        if (card.format !== "none" && !WRITABLE.has(card.format)) card.format = normalizeFormat(card.format);
        await DB.put(card);
        dropURL(card.id);
        n++;
      }
      await load();
      toast(n === 1 ? "1 tessera importata" : `${n} tessere importate`);
    } catch {
      toast("File di backup non valido");
    }
  });

  /* ───────────── avvio ───────────── */
  load();
  if ("serviceWorker" in navigator && location.protocol === "https:") {
    navigator.serviceWorker.register("sw.js").catch(() => {});
  }
  // carico in anticipo il motore dei codici, così la prima lettura è veloce
  setTimeout(() => {
    if (Z && !zxReady) Promise.resolve(Z.prepareZXingModule({ overrides: ZX_OVERRIDES, fireImmediately: true })).then(() => { zxReady = true; }, () => {});
  }, 800);

  // per i test
  window.__tessere = { get cards() { return cards; }, layout, drawFace: drawBrandFace };
})();
