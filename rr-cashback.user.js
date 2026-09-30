// ==UserScript==
// @name         Cashback R&R : rappel d'activation
// @namespace    remises-reductions.cashback-manquant
// @version      1.0.3
// @description  Sur les sites partenaires de Remises & Réductions, propose d'activer le cashback en un clic, et insiste au panier s'il ne l'est pas.
// @author       ZaRoXUltrA
// @match        *://*/*
// @noframes
// @run-at       document-idle
// @connect      www.remisesetreductions.fr
// @grant        GM_getValue
// @grant        GM_setValue
// @grant        GM_deleteValue
// @grant        GM_addValueChangeListener
// @grant        GM_xmlhttpRequest
// @grant        GM_openInTab
// @grant        GM_registerMenuCommand
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
        keys: [...new Set([slug(d.Cashback.url_name), slug(d.Name)].filter((k) => k.length >= 3))],
        words: [...new Set(d.Name.split(/[\s'’&.,:/+-]+/).map(slug).filter((w) => w.length >= 3))],
      }));
  }

  const isCheckout = (loc) => CHECKOUT.test(loc.pathname + loc.search + loc.hash);

  if (typeof module !== "undefined" && module.exports) {
    module.exports = { slug, hostKeys, baseDomain, findMerchant, parseMerchants, isCheckout };
    return; // chargé par les tests (Node) : pas d'interface
  }

  // ---------------------------------------------------------------- stockage
  const get = (k, d) => GM_getValue(k, d);
  const set = (k, v) => GM_setValue(k, v);
  const host = location.hostname;
  const base = baseDomain(host);

  function loadMerchants(force = false) {
    const cache = get("merchants", null);
    if (!force && cache && Date.now() - cache.at < LIST_TTL) return Promise.resolve(cache.list);
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
            set("merchants", { at: Date.now(), list });
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

  // ---------------------------------------------------------------- sur le site R&R
  if (base === "remisesetreductions.fr") {
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
    if (!cache || !cache.list.length || Date.now() - cache.at > LIST_TTL) {
      fetch("/Merchants", { credentials: "same-origin" })
        .then((r) => r.text())
        .then((html) => {
          const list = parseMerchants(html);
          if (list && list.length) {
            set("merchants", { at: Date.now(), list });
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
    // Sans domaine attendu (clic depuis R&R), on accepte le premier site qui ressemble au marchand
    // ou, à défaut, le premier site hors réseaux d'affiliation.
    if (expected && expected !== base) {
      if (!(m && findMerchant(host, [m]))) return false;
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
      .mini { padding: 8px 12px; cursor: pointer; }
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
    const { merchant, active, loud, needLogin } = state;
    const bonus = merchant.bonus ? ` <span style="opacity:.7">(${esc(merchant.bonus)})</span>` : "";
    let html;
    if (active) {
      const min = Math.max(1, Math.round((Date.now() - active.at) / 60e3));
      html = `<div class="card mini" data-a="close" title="Cashback activé via Remises & Réductions (clic pour masquer)">
          <span class="pill"><span class="dot"></span>Cashback R&amp;R activé · ${esc(merchant.name)} · il y a ${min} min</span></div>`;
    } else {
      html = `<div class="card ${loud ? "loud" : ""}">
          <div class="head"><span class="brand">REMISES &amp; RÉDUCTIONS</span><button class="x" data-a="close" title="Masquer">✕</button></div>
          <div class="msg">${loud
            ? `Cashback <b>pas activé</b> chez ${esc(merchant.name)} : active-le <b>avant de payer</b> pour récupérer ${esc(merchant.rebate)}.`
            : `<b>${esc(merchant.rebate)}</b> remboursés chez ${esc(merchant.name)}${bonus}.`}</div>
          ${needLogin ? `<div class="msg" style="opacity:.75;font-size:12.5px">Connecte-toi sur remisesetreductions.fr dans ce navigateur pour que l'activation fonctionne.</div>` : ""}
          <div class="row">
            <button class="btn" data-a="activate">Activer le cashback</button>
            <button class="link" data-a="mute">Ne plus proposer sur ce site</button>
          </div>
        </div>`;
    }
    shadow.innerHTML = `<style>${css()}</style>${html}`;
    shadow.querySelectorAll("[data-a]").forEach((el) => el.addEventListener("click", () => onAction(el.dataset.a, state)));
  }

  function esc(s) {
    return String(s).replace(/[&<>"']/g, (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" }[c]));
  }

  function hide() {
    if (root) root.remove();
    root = shadow = null;
  }

  function onAction(action, state) {
    if (action === "close") return hide();
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
      list.length ? "" : "→ Ouvre remisesetreductions.fr en étant connecté : la liste s'y charge toute seule.",
    ].filter(Boolean).join("\n"));
  });
  GM_registerMenuCommand("Recharger la liste des marchands R&R", () => {
    set("merchants", null);
    openRR(); // chargée par le script sur le site R&R, avec ta session
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

    const refresh = () => {
      const active = activeFor(base);
      render({ merchant, active, loud: !active && isCheckout(location), needLogin: get("needLogin", false) });
    };
    refresh();

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
