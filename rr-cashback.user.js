// ==UserScript==
// @name         Cashback R&R : rappel d'activation
// @namespace    remises-reductions.cashback-manquant
// @version      1.3.1
// @description  Sur les sites partenaires de Remises & Réductions, propose d'activer le cashback en un clic, insiste au panier s'il ne l'est pas, et compare avec les taux d'iGraal, TopCashback, eBuyClub, Widilo et Poulpeo.
// @author       ZaRoXUltrA
// @match        *://*/*
// @noframes
// @run-at       document-idle
// @connect      www.remisesetreductions.fr
// @connect      fr.igraal.com
// @connect      www.topcashback.fr
// @connect      www.ebuyclub.com
// @connect      www.widilo.fr
// @connect      www.poulpeo.com
// @grant        GM_getValue
// @grant        GM_setValue
// @grant        GM_deleteValue
// @grant        GM_addValueChangeListener
// @grant        GM_xmlhttpRequest
// @grant        GM_openInTab
// @grant        GM_registerMenuCommand
// @grant        GM_setClipboard
// @updateURL    https://raw.githubusercontent.com/ZaRoXUltrA/cashback-manquant-versions/main/rr-cashback.user.js
// @downloadURL  https://raw.githubusercontent.com/ZaRoXUltrA/cashback-manquant-versions/main/rr-cashback.user.js
// ==/UserScript==

/*
 * Principe
 * - La liste des marchands vient de la page « Tous les marchands » de R&R (variable dataMerchants),
 *   lue avec la session R&R du navigateur, gardée 24 h.
 * - Le site visité est rapproché d'un marchand par son domaine (fnac.com → « Fnac ») ou par une
 *   correspondance apprise lors d'une activation précédente.
 * - « Activer » ouvre https://www.remisesetreductions.fr/Merchant/Shop/Cashback/<id> (le lien du
 *   bouton ACHETER de R&R) dans un nouvel onglet. Arrivé chez le marchand, cet onglet note
 *   l'activation et se ferme : on reste sur sa page (produit, panier…).
 * - L'activation reste toujours une action de l'utilisateur (un clic) : jamais d'activation
 *   automatique, pratique interdite par les réseaux d'affiliation.
 */

(function () {
  "use strict";

  const RR = "https://www.remisesetreductions.fr";
  const LIST_TTL = 6 * 3600e3; // liste des marchands : rafraîchie toutes les 6 h (R&R en ajoute et en retire souvent)
  // Format de la liste : à augmenter quand parseMerchants lit un nouveau champ (sinon une liste
  // gardée par l'ancienne version reste utilisée jusqu'à 6 h, sans ce champ : codes promo en 1.3.0).
  const LIST_V = 2;
  const listFresh = (c) => c && c.v === LIST_V && c.list.length && Date.now() - c.at < LIST_TTL;
  const ACTIVE_TTL = 2 * 3600e3; // une activation est considérée valable 2 h
  const PENDING_TTL = 3 * 60e3; // délai max. entre le clic et l'arrivée chez le marchand
  const CHECKOUT = /(panier|cart|basket|checkout|commande|paiement|payment|caisse|tunnel|order)/i;
  const TLDS = new Set(["com", "fr", "net", "org", "eu", "de", "es", "it", "be", "ch", "co", "uk", "io", "shop", "store"]);
  // Domaines traversés pendant la redirection (réseaux d'affiliation) : jamais des marchands
  const NETWORKS = /(awin1|metaffiliation|tradedoubler|effiliation|kwanko|netaffiliation|zanox|cj|anrdoezrs|dpbolvw|jdoqocy|tkqlhce|kqzyfj|rakuten|linksynergy|webgains|timeone|doubleclick|googleadservices|clickref|affili)/i;

  // ---------------------------------------------------------------- utilitaires purs
  const slug = (s) => (s || "").normalize("NFKD").replace(/[̀-ͯ]/g, "").toLowerCase().replace(/[^a-z0-9]/g, "");

  /** Formes d'un nom d'hôte à comparer aux marchands : « www.fnac.com » → ["fnaccom", "fnac"]. */
  function hostKeys(host) {
    const labels = host.toLowerCase().replace(/^www\d?\./, "").split(".").filter(Boolean);
    const withoutTld = labels.filter((l, i) => !(i > 0 && TLDS.has(l)));
    const keys = [slug(labels.join("")), slug(withoutTld.join(""))];
    if (withoutTld.length) keys.push(slug(withoutTld[withoutTld.length - 1]));
    return [...new Set(keys.filter((k) => k.length >= 3))];
  }

  /** Domaine « principal » (pour associer sous-domaines et activation) : www.fnac.com → fnac.com */
  function baseDomain(host) {
    const labels = host.toLowerCase().split(".");
    const n = labels.length >= 3 && TLDS.has(labels[labels.length - 2]) ? 3 : 2;
    return labels.slice(-n).join(".");
  }

  /** Marchand correspondant au site : égalité exacte d'abord, puis préfixe (micromania → micromaniazing). */
  function findMerchant(host, merchants, learned = {}) {
    const base = baseDomain(host);
    if (learned[base] != null) {
      const m = merchants.find((x) => x.id === learned[base]);
      if (m) return m;
    }
    if (NETWORKS.test(host) || base === "remisesetreductions.fr") return null;
    const keys = hostKeys(host);
    for (const k of keys) {
      const exact = merchants.filter((m) => m.keys.includes(k));
      if (exact.length === 1) return exact[0];
      if (exact.length > 1) return exact.sort((a, b) => a.name.length - b.name.length)[0];
    }
    for (const k of keys) {
      if (k.length < 5) continue;
      const pre = merchants.filter((m) => m.keys.some((mk) => mk.startsWith(k) || (mk.length >= 5 && k.startsWith(mk))));
      if (pre.length === 1) return pre[0];
    }
    // Mots dans le désordre : zalando-prive.fr → « Privé by Zalando »
    const words = host.toLowerCase().replace(/^www\d?\./, "").split(".")[0].split("-").map(slug).filter((w) => w.length >= 4);
    if (words.length >= 2) {
      const hits = merchants.filter((m) => words.every((w) => (m.words || []).includes(w)));
      if (hits.length === 1) return hits[0];
    }
    return null;
  }

  /** Liste réduite des marchands depuis le HTML de la page « Tous les marchands ». */
  function parseMerchants(html) {
    const m = html.match(/var\s+dataMerchants\s*=\s*(\[[\s\S]*?\])\s*;?\s*<\/script>/);
    if (!m) return null;
    return JSON.parse(m[1])
      .filter((d) => d.Cashback && d.HasCashback !== false)
      .map((d) => ({
        id: d.Id,
        name: d.Name,
        rebate: d.FinalRebate || d.BaseRebate || "",
        bonus: d.BonusActive ? d.BonusText || "" : "",
        url: d.Cashback.url_name, // adresse R&R (fnac, micromania-zing) : sert à deviner celle des autres sites
        // Codes promo publiés par R&R : les seuls compatibles avec son cashback (CGU, art. 4.1).
        // Sans code (« prix spécial ») ou expirés depuis plus d'un jour : ignorés.
        coupons: (d.Coupons || [])
          .filter((c) => c.coupon_code && (!c.end_date || new Date(c.end_date.replace(" ", "T")) > Date.now() - 864e5))
          .map((c) => ({ code: c.coupon_code, text: c.description || c.coupon_name || "", end: (c.end_date || "").slice(0, 10) })),
        keys: [...new Set([slug(d.Cashback.url_name), slug(d.Name)].filter((k) => k.length >= 3))],
        words: [...new Set(d.Name.split(/[\s'’&.,:/+-]+/).map(slug).filter((w) => w.length >= 3))],
      }));
  }

  const isCheckout = (loc) => CHECKOUT.test(loc.pathname + loc.search + loc.hash);

  // ---------------------------------------------------------------- autres sites de cashback
  // Taux des sites concurrents, pour comparer avec R&R. Pages publiques, lues sans cookies.
  // Adresses des pages marchand : plan du site (sitemap), sinon devinées depuis le nom R&R.
  // ponytail: lecture du HTML de chaque site ; un site qui change sa page disparaît juste de la ligne.
  const rx = (re) => (html) => ((html || "").match(re) || [])[1]?.trim() || null;
  const RIVALS = [
    {
      // Refuse les requêtes anonymes : lu avec les cookies du navigateur, comme une visite normale.
      // S'il refuse quand même, iGraal n'apparaît simplement pas dans la ligne.
      name: "iGraal", host: "fr.igraal.com", cookies: true, sitemap: "https://fr.igraal.com/sitemap.xml",
      loc: /<loc>\s*(https:\/\/fr\.igraal\.com\/codes-promo\/([^/<\s]+)[^<\s]*)\s*<\/loc>/g,
      rate: rx(/<title>[^<]*?([\d.,]+\s*(?:%|€))\s*(?:de\s+)?cashback/i), // « Code promo Cdiscount + 2 % Cashback »
    },
    {
      name: "TopCashback", host: "www.topcashback.fr", sitemap: "https://www.topcashback.fr/sitemap.xml",
      loc: /<loc>\s*(https:\/\/www\.topcashback\.fr\/([^/<\s]+)\/)\s*<\/loc>/g,
      rate: (html) => { // un taux par catégorie de produits : on garde le plus haut
        const all = [...(html || "").matchAll(/class="merch-cat__rate"[^>]*>\s*([^<]+?)\s*</g)].map((m) => m[1]);
        return all.sort((a, b) => (pct(b) || 0) - (pct(a) || 0))[0] || null;
      },
    },
    {
      name: "eBuyClub", host: "www.ebuyclub.com", sitemap: "https://www.ebuyclub.com/sitemap-reduction.xml",
      loc: /<loc>\s*(https:\/\/www\.ebuyclub\.com\/reduction-([^<\s]+?)-\d+)\s*<\/loc>/g,
      rate: (html, url) => { // fiche du marchand (n° dans l'adresse) → cashback « en ligne »
        const h = (html || "").replace(/\\"/g, '"');
        const i = h.indexOf(`"id":${(url.match(/-(\d+)$/) || [])[1]},"name":`);
        return i < 0 ? null : rx(/"online":\{[^}]*?"discount":"([^"]+)"/)(h.slice(i, i + 5000));
      },
    },
    {
      name: "Widilo", host: "www.widilo.fr", // pas de plan du site public : adresse devinée
      guess: (m) => [m.url, ...m.keys].filter(Boolean).map((s) => `https://www.widilo.fr/code-promo/${s}`),
      rate: rx(/widilo-deal-shop-card_body_top_content_value_value">\s*([^<]+?)\s*</),
    },
    {
      name: "Poulpeo", host: "www.poulpeo.com", sitemap: "https://www.poulpeo.com/sitemap.xml",
      loc: /<loc>\s*(https:\/\/www\.poulpeo\.com\/reductions-([^<\s]+?)\.htm)\s*<\/loc>/g,
      // Bloc du marchand : « Jusqu'à 2,5% remboursés sur vos achats Voir l'offre » (absent = pas de
      // cashback chez eux). Les publicités pour d'autres marchands (« Annonce … remboursés sur vos
      // achats Découvrir ») et la colonne « 5% en ligne » sont ignorées.
      rate: (html) => rx(/([\d.,]+\s*(?:%|€))\s+remboursés sur vos achats\s+Voir l/)((html || "").replace(/<[^>]+>/g, " ").replace(/&nbsp;|\s+/g, " ")),
    },
  ];

  /** « 2,5 % » → 2.5 ; montants en euros et textes sans % → null (pas comparables). */
  function pct(rate) {
    const m = /([\d]+(?:[.,]\d+)?)\s*%/.exec(rate || "");
    return m ? parseFloat(m[1].replace(",", ".")) : null;
  }

  /** Taux lisible ou null : entités HTML décodées, 0 % écarté (marchand sans cashback). */
  function rivalRate(rival, html, url) {
    const r = (rival.rate(html, url) || "")
      .replace(/&#x([0-9a-f]+);/gi, (_, h) => String.fromCharCode(parseInt(h, 16)))
      .replace(/&#(\d+);/g, (_, d) => String.fromCharCode(+d)).replace(/&nbsp;| /g, " ").trim();
    return r && pct(r) !== 0 ? r : null;
  }

  /** Plan du site → { forme simplifiée du nom : adresse de la page marchand }. */
  function parseSitemap(xml, re) {
    const map = {};
    for (const m of (xml || "").matchAll(re)) {
      const k = slug(m[2]);
      if (k && !map[k]) map[k] = m[1];
    }
    return map;
  }

  /** Adresse(s) candidates du marchand R&R sur un site : nom exact, ou nom + « fr » (auchan-fr). */
  function rivalUrls(rival, merchant, map) {
    if (rival.guess) return rival.guess(merchant);
    let hit = merchant.keys.map((k) => map[k] || map[k + "fr"]).find(Boolean);
    if (!hit) { // nom R&R plus long : micromaniazing → micromania (le plus long préfixe d'au moins 6 lettres)
      const pre = Object.keys(map).filter((s) => s.length >= 6 && merchant.keys.some((k) => k.startsWith(s)));
      hit = map[pre.sort((a, b) => b.length - a.length)[0]];
    }
    return hit ? [hit] : [];
  }

  if (typeof module !== "undefined" && module.exports) {
    module.exports = { slug, hostKeys, baseDomain, findMerchant, parseMerchants, isCheckout, RIVALS, pct, rivalRate, parseSitemap, rivalUrls };
    return; // chargé par les tests (Node) : pas d'interface
  }

  // ---------------------------------------------------------------- stockage
  const get = (k, d) => GM_getValue(k, d);
  const set = (k, v) => GM_setValue(k, v);
  const host = location.hostname;
  const base = baseDomain(host);
  // 1.0.4 : les associations apprises par erreur (ESN partout…) sont effacées une fois.
  if (get("learnedV", 0) < 2) { set("learned", {}); set("active", {}); set("learnedV", 2); }

  function loadMerchants(force = false) {
    const cache = get("merchants", null);
    if (!force && listFresh(cache)) return Promise.resolve(cache.list);
    // Chrome n'envoie souvent pas les cookies R&R depuis un autre site : on ne réessaie qu'une
    // fois par heure (la liste est surtout chargée par le script quand R&R est ouvert).
    if (!force && Date.now() - get("lastFetchTry", 0) < 3600e3) return Promise.resolve(cache ? cache.list : []);
    set("lastFetchTry", Date.now());
    return new Promise((resolve) => {
      GM_xmlhttpRequest({
        method: "GET",
        url: RR + "/Merchants",
        timeout: 20000,
        onload: (r) => {
          const list = parseMerchants(r.responseText || "");
          if (list && list.length) {
            set("merchants", { at: Date.now(), v: LIST_V, list });
            set("needLogin", false);
            resolve(list);
          } else {
            // Page de connexion reçue : cookies non envoyés (fréquent) ou session expirée.
            resolve(cache ? cache.list : []);
          }
        },
        onerror: () => resolve(cache ? cache.list : []),
        ontimeout: () => resolve(cache ? cache.list : []),
      });
    });
  }

  const activations = () => get("active", {});
  function markActive(domain, merchantId) {
    const a = activations();
    a[domain] = { at: Date.now(), id: merchantId };
    set("active", a);
  }
  function activeFor(domain) {
    const a = activations()[domain];
    return a && Date.now() - a.at < ACTIVE_TTL ? a : null;
  }
  function learn(domain, merchantId) {
    const l = get("learned", {});
    l[domain] = merchantId;
    set("learned", l);
  }

  const log = (...a) => console.info("[Cashback R&R]", ...a);

  // ---------------------------------------------------------------- autres sites : chargement
  const RIVAL_TTL = 24 * 3600e3; // plans des sites : 24 h ; taux d'un marchand : 12 h
  // anonymous : sans les cookies du navigateur, ces sites ne savent pas qui consulte la page
  // (sauf ceux marqués cookies, qui refusent les visites anonymes).
  const fetchText = (url, cookies = false) => new Promise((resolve) => GM_xmlhttpRequest({
    method: "GET", url, anonymous: !cookies, timeout: 20000,
    onload: (r) => resolve(r.status === 200 ? r.responseText : ""),
    onerror: () => resolve(""),
    ontimeout: () => resolve(""),
  }));

  async function rivalMap(rival) {
    if (!rival.sitemap) return {};
    const c = get("rivalMap:" + rival.name, null);
    if (c && Date.now() - c.at < RIVAL_TTL) return c.map;
    const map = parseSitemap(await fetchText(rival.sitemap, rival.cookies), rival.loc);
    if (Object.keys(map).length) set("rivalMap:" + rival.name, { at: Date.now(), map });
    return Object.keys(map).length ? map : (c ? c.map : {});
  }

  async function loadRivals(merchant) {
    const key = "rivals:" + merchant.id;
    const c = get(key, null);
    if (c && Date.now() - c.at < RIVAL_TTL / 2) return c.list;
    const status = {}; // pour le menu Diagnostic : ce qui s'est passé sur chaque site
    const list = (await Promise.all(RIVALS.map(async (rival) => {
      const urls = rivalUrls(rival, merchant, await rivalMap(rival));
      status[rival.name] = urls.length ? "pas de cashback, ou taux illisible (page changée ?)" : "marchand introuvable sur ce site";
      for (const url of urls) {
        const html = await fetchText(url, rival.cookies);
        if (!html) { status[rival.name] = "page inaccessible (site bloqué ou indisponible)"; continue; }
        const rate = rivalRate(rival, html, url);
        if (rate) { status[rival.name] = rate; return { name: rival.name, rate, url }; }
      }
      return null;
    }))).filter(Boolean);
    set(key, { at: Date.now(), list, status });
    log("Autres sites :", status);
    return list;
  }

  // ---------------------------------------------------------------- sur le site R&R
  if (base === "remisesetreductions.fr") {
    // « Rester connecté » est décoché par défaut : sans lui, R&R pose un cookie de connexion
    // qui disparaît à la fermeture du navigateur (d'où les reconnexions à répétition).
    const remember = (scope) => scope.querySelectorAll('input[name="RememberMe"]').forEach((c) => { c.checked = true; });
    remember(document);
    document.addEventListener("focusin", (e) => { if (e.target.form) remember(e.target.form); }, true);
    document.addEventListener("submit", (e) => remember(e.target), true);
    // Clic sur ACHETER depuis R&R : l'onglet qui arrivera chez le marchand notera l'activation.
    document.addEventListener("click", (e) => {
      const a = e.target.closest && e.target.closest('a[href*="/Merchant/Shop/Cashback/"]');
      if (!a) return;
      const id = Number((a.getAttribute("href").match(/Cashback\/(\d+)/) || [])[1]);
      if (id) set("pending", { id, at: Date.now(), from: "rr" });
    }, true);
    // Liste des marchands lue ici, avec la session du site : fiable même quand le navigateur
    // n'envoie pas les cookies R&R aux requêtes faites depuis un autre site.
    const cache = get("merchants", null);
    if (!listFresh(cache)) {
      fetch("/Merchants", { credentials: "same-origin" })
        .then((r) => r.text())
        .then((html) => {
          const list = parseMerchants(html);
          if (list && list.length) {
            set("merchants", { at: Date.now(), v: LIST_V, list });
            set("needLogin", false);
            log(`${list.length} marchands chargés depuis le site R&R.`);
          } else {
            set("needLogin", true); // sur le site R&R lui-même : vraiment pas connecté
            log("Liste des marchands indisponible : es-tu connecté à R&R ?");
          }
        })
        .catch((e) => log("Chargement de la liste impossible :", e));
    }
    return;
  }

  // ---------------------------------------------------------------- arrivée après activation
  function handleLanding(merchants) {
    const p = get("pending", null);
    if (!p || Date.now() - p.at > PENDING_TTL || NETWORKS.test(host)) return false;
    const expected = p.domain;
    const m = merchants.find((x) => x.id === p.id);
    // Sans domaine attendu (clic depuis R&R), on n'accepte qu'un site qui ressemble au marchand
    // ou une page arrivée depuis R&R / un réseau d'affiliation. Avant, le premier site chargé
    // dans n'importe quel onglet était appris comme ce marchand, pour toujours (ESN partout).
    const looksLike = m && findMerchant(host, [m]);
    if (expected && expected !== base) {
      if (!looksLike) return false;
    } else if (!expected && !looksLike) {
      let ref = "";
      try { ref = new URL(document.referrer).hostname; } catch (_) {}
      if (!ref || !(NETWORKS.test(ref) || baseDomain(ref) === "remisesetreductions.fr")) return false;
    }
    GM_deleteValue("pending");
    learn(base, p.id);
    markActive(base, p.id);
    if (expected && expected !== base) markActive(expected, p.id);
    if (p.from === "banner") {
      set("landed", { at: Date.now(), domain: expected || base });
      setTimeout(() => window.close(), 1500); // l'onglet d'origine le ferme aussi de son côté
    }
    return true;
  }

  // ---------------------------------------------------------------- bandeau
  let root, shadow, tabHandle;

  function css() {
    return `
      :host { all: initial; }
      .card {
        position: fixed; z-index: 2147483646; right: 20px; bottom: 20px; max-width: 360px;
        font: 13.5px/1.45 system-ui, -apple-system, "Segoe UI", sans-serif; color: #f4f3ee;
        background: #1c1b18; border-radius: 12px; box-shadow: 0 12px 32px rgba(0,0,0,.28);
        padding: 14px 16px; display: flex; flex-direction: column; gap: 10px;
      }
      .card.loud { border: 2px solid #e0a64a; top: 20px; bottom: auto; right: 50%; transform: translateX(50%); max-width: 460px; }
      .head { display: flex; align-items: baseline; gap: 8px; }
      .brand { font-weight: 600; font-size: 12px; opacity: .6; letter-spacing: .02em; }
      .x { margin-left: auto; background: none; border: 0; color: inherit; opacity: .55; cursor: pointer; font-size: 15px; padding: 0 2px; }
      .x:hover { opacity: 1; }
      .msg b { color: #7fd1a6; }
      .rivals { font-size: 12.5px; opacity: .8; }
      .rivals a { color: inherit; text-decoration: underline dotted; text-underline-offset: 2px; white-space: nowrap; }
      .rivals a.better { color: #f0c27a; font-weight: 600; opacity: 1; }
      .codes { display: flex; flex-direction: column; gap: 4px; font-size: 12.5px; }
      .codes-h { opacity: .6; font-size: 11.5px; }
      .code { display: flex; gap: 8px; align-items: baseline; }
      .code .end { opacity: .55; }
      .copy { font: 600 12px ui-monospace, Consolas, monospace; color: #7fd1a6; background: rgba(127,209,166,.12);
        border: 1px dashed rgba(127,209,166,.5); border-radius: 6px; padding: 2px 7px; cursor: pointer; flex: none; }
      .copy.done { color: #1c1b18; background: #7fd1a6; border-style: solid; }
      .loud .msg { font-size: 14.5px; }
      .loud .msg b { color: #f0c27a; }
      .row { display: flex; gap: 8px; align-items: center; flex-wrap: wrap; }
      .btn {
        font: 600 13px system-ui, sans-serif; border: 0; border-radius: 8px; padding: 8px 14px; cursor: pointer;
        background: #3fa872; color: #0c1d14;
      }
      .btn:hover { background: #56bb86; }
      .link { background: none; border: 0; color: inherit; opacity: .6; cursor: pointer; font: 12px system-ui, sans-serif; text-decoration: underline; }
      .pill { display: inline-flex; align-items: center; gap: 6px; }
      .dot { width: 8px; height: 8px; border-radius: 50%; background: #3fa872; }
      .mini { padding: 8px 12px; gap: 6px; }
      .mini .pill { cursor: pointer; }
    `;
  }

  function mount() {
    if (root) return;
    root = document.createElement("div");
    root.id = "rr-cashback-rappel";
    shadow = root.attachShadow({ mode: "closed" });
    document.documentElement.appendChild(root);
  }

  function render(state) {
    mount();
    const { merchant, active, loud, needLogin, rivals = [] } = state;
    const rrPct = pct(merchant.rebate);
    const others = rivals.length ? `<div class="rivals">Ailleurs : ${rivals.map((r) => {
      const better = rrPct != null && pct(r.rate) > rrPct;
      return `<a href="${esc(r.url)}" target="_blank" rel="noopener noreferrer" class="${better ? "better" : ""}"` +
        `${better ? ' title="Mieux que R&amp;R"' : ""}>${esc(r.name)} ${esc(r.rate)}</a>`;
    }).join(" · ")}</div>` : "";
    const bonus = merchant.bonus ? ` <span style="opacity:.7">(${esc(merchant.bonus)})</span>` : "";
    // Codes R&R (compatibles avec le cashback) ; ceux des autres sites le font perdre et ne
    // s'obtiennent qu'en passant par leur lien d'affiliation : jamais affichés ni révélés ici.
    const coupons = (merchant.coupons || []).slice(0, 4);
    const codes = coupons.length ? `<div class="codes"><div class="codes-h">Codes promo R&amp;R (gardent le cashback)</div>${coupons.map((c, i) =>
      `<div class="code"><button class="copy" data-a="copy" data-i="${i}" title="Copier le code">${esc(c.code)}</button>` +
      `<span>${esc(c.text)}${c.end ? ` <span class="end">· jusqu'au ${esc(c.end.split("-").reverse().join("/"))}</span>` : ""}</span></div>`).join("")}</div>` : "";
    let html;
    if (active) {
      const min = Math.max(1, Math.round((Date.now() - active.at) / 60e3));
      // Ligne « Ailleurs » aussi sous la pastille ; seule la pastille masque le bandeau (pas les liens)
      html = `<div class="card mini">
          <span class="pill" data-a="close" title="Cashback activé via Remises & Réductions (clic pour masquer)"><span class="dot"></span>Cashback R&amp;R activé · ${esc(merchant.name)} · il y a ${min} min</span>${codes}${others}</div>`;
    } else {
      html = `<div class="card ${loud ? "loud" : ""}">
          <div class="head"><span class="brand">REMISES &amp; RÉDUCTIONS</span><button class="x" data-a="close" title="Masquer">✕</button></div>
          <div class="msg">${loud
            ? `Cashback <b>pas activé</b> chez ${esc(merchant.name)} : active-le <b>avant de payer</b> pour récupérer ${esc(merchant.rebate)}.`
            : `<b>${esc(merchant.rebate)}</b> remboursés chez ${esc(merchant.name)}${bonus}.`}</div>
          ${codes}
          ${others}
          ${needLogin ? `<div class="msg" style="opacity:.75;font-size:12.5px">Connecte-toi sur remisesetreductions.fr dans ce navigateur pour que l'activation fonctionne.</div>` : ""}
          <div class="row">
            <button class="btn" data-a="activate">Activer le cashback</button>
            <button class="link" data-a="mute">Ne plus proposer sur ce site</button>
          </div>
        </div>`;
    }
    shadow.innerHTML = `<style>${css()}</style>${html}`;
    shadow.querySelectorAll("[data-a]").forEach((el) => el.addEventListener("click", () => onAction(el.dataset.a, state, el)));
  }

  function esc(s) {
    return String(s).replace(/[&<>"']/g, (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" }[c]));
  }

  function hide() {
    if (root) root.remove();
    root = shadow = null;
  }

  function onAction(action, state, el) {
    if (action === "close") return hide();
    if (action === "copy") {
      GM_setClipboard(state.merchant.coupons[+el.dataset.i].code, "text");
      el.classList.add("done");
      el.title = "Copié : colle-le dans le champ code promo du panier";
      return;
    }
    if (action === "mute") {
      const muted = get("muted", {});
      muted[base] = true;
      set("muted", muted);
      return hide();
    }
    if (action === "activate") {
      set("pending", { id: state.merchant.id, domain: base, at: Date.now(), from: "banner" });
      tabHandle = GM_openInTab(`${RR}/Merchant/Shop/Cashback/${state.merchant.id}`, { active: true, insert: true, setParent: true });
    }
  }

  // ---------------------------------------------------------------- démarrage
  const openRR = () => GM_openInTab(`${RR}/Merchants`, { active: true });
  GM_registerMenuCommand("Diagnostic", () => {
    const cache = get("merchants", null);
    const list = cache ? cache.list : [];
    const m = list.length ? findMerchant(host, list, get("learned", {})) : null;
    const act = activeFor(base);
    alert([
      `Script version ${GM_info.script.version}`,
      `Marchands en mémoire : ${list.length}${cache ? ` (chargés le ${new Date(cache.at).toLocaleString("fr-FR")})` : ""}`,
      `Ce site (${host}) : ${m ? `reconnu comme « ${m.name} » (${m.rebate})` : "non reconnu comme marchand R&R"}`,
      `Cashback : ${act ? `activé il y a ${Math.round((Date.now() - act.at) / 60e3)} min` : "pas activé"}`,
      get("muted", {})[base] ? "Bandeau masqué sur ce site (menu « Réafficher… »)." : "",
      ...(() => {
        const r = m && get("rivals:" + m.id, null);
        if (!m) return [];
        if (!r || !r.status) return ["Autres sites : pas encore consultés pour ce marchand."];
        return [`Autres sites (lus le ${new Date(r.at).toLocaleString("fr-FR")}, relus toutes les 12 h) :`,
          ...RIVALS.map((x) => `   ${x.name} : ${r.status[x.name] || "?"}`)];
      })(),
      list.length ? "" : "→ Ouvre remisesetreductions.fr en étant connecté : la liste s'y charge toute seule.",
    ].filter(Boolean).join("\n"));
  });
  GM_registerMenuCommand("Recharger la liste des marchands R&R", () => {
    set("merchants", null);
    openRR(); // chargée par le script sur le site R&R, avec ta session
  });
  GM_registerMenuCommand("Relire les taux des autres sites", () => {
    const m = findMerchant(host, (get("merchants", null) || { list: [] }).list, get("learned", {}));
    if (m) set("rivals:" + m.id, null);
    RIVALS.forEach((x) => set("rivalMap:" + x.name, null));
    location.reload();
  });
  GM_registerMenuCommand("Réafficher sur tous les sites masqués", () => { set("muted", {}); alert("Les sites masqués seront de nouveau proposés."); });
  GM_registerMenuCommand("Oublier les activations en cours", () => { set("active", {}); location.reload(); });

  // Liste absente : message discret, au plus une fois toutes les 6 h
  function renderNoList() {
    if (Date.now() - get("noListNoticeAt", 0) < 6 * 3600e3) return;
    set("noListNoticeAt", Date.now());
    mount();
    shadow.innerHTML = `<style>${css()}</style><div class="card">
      <div class="head"><span class="brand">REMISES &amp; RÉDUCTIONS</span><button class="x" data-a="close" title="Masquer">✕</button></div>
      <div class="msg">Le rappel cashback n'a pas encore la liste des marchands. Ouvre Remises &amp; Réductions
        une fois, <b>en étant connecté</b> : elle se charge toute seule.</div>
      <div class="row"><button class="btn" data-a="openrr">Ouvrir Remises &amp; Réductions</button></div></div>`;
    shadow.querySelector("[data-a=close]").addEventListener("click", hide);
    shadow.querySelector("[data-a=openrr]").addEventListener("click", () => { hide(); openRR(); });
  }

  loadMerchants().then((merchants) => {
    if (!merchants.length) {
      log("Aucun marchand en mémoire : ouvrir remisesetreductions.fr connecté pour charger la liste.");
      // La liste arrive quand R&R est ouvert dans un autre onglet : on démarre à ce moment-là.
      GM_addValueChangeListener("merchants", (_k, _old, val) => {
        if (val && val.list && val.list.length && !started) { hide(); start(val.list); }
      });
      return renderNoList();
    }
    start(merchants);
  });

  let started = false;
  function start(merchants) {
    started = true;
    if (handleLanding(merchants)) {
      const m = merchants.find((x) => x.id === activeFor(base).id);
      if (m) render({ merchant: m, active: activeFor(base) });
      return;
    }
    const merchant = findMerchant(host, merchants, get("learned", {}));
    if (!merchant || get("muted", {})[base]) return;

    let rivals = [];
    const refresh = () => {
      const active = activeFor(base);
      render({ merchant, active, loud: !active && isCheckout(location), needLogin: get("needLogin", false), rivals });
    };
    refresh();
    // Taux des autres sites : arrivent après coup (pas réaffiché si le bandeau a été fermé)
    loadRivals(merchant).then((list) => { rivals = list; if (root && list.length) refresh(); });

    // Activation terminée dans l'onglet ouvert par « Activer » : on le ferme et on met à jour.
    GM_addValueChangeListener("landed", (_k, _old, val) => {
      if (val && val.domain === base) {
        if (tabHandle && !tabHandle.closed) setTimeout(() => tabHandle.close(), 1200);
        refresh();
      }
    });
    // Sites qui changent de page sans recharger (panier en une page, etc.)
    let last = location.href;
    setInterval(() => { if (location.href !== last) { last = location.href; refresh(); } }, 1500);
  }
})();
