/* API simulée pour la prévisualisation : même contrat que le serveur, données
   en mémoire, aucun réseau. Les valeurs __XXX__ sont injectées à la construction. */
(() => {
  window.__PREVIEW__ = true;
  const DICTIONARIES = __DICTIONARIES__;
  const LOCALES = __LOCALES__;
  const CATEGORIES = __CATEGORIES__;
  const DEMO_TRANSLATION = __DEMO_TRANSLATION__;
  const ADMIN_EMAILS = ["moderation@drdu.example"];
  const AUTO_APPROVE = false;

  const now = () => new Date().toISOString();
  let counter = 0;
  const uuid = () => `p${(++counter).toString(36)}${Math.random().toString(36).slice(2, 8)}`;
  const reference = () => `DR-${Math.random().toString(16).slice(2, 8).toUpperCase()}`;
  const at = (days, hour, minute = 0) => {
    const d = new Date(Date.now() + days * 86400000);
    d.setHours(hour, minute, 0, 0);
    return d.toISOString();
  };

  /* ---------- Données ---------- */
  const db = { users: [], merchants: [], services: [], slots: [], bookings: [], messages: [], translations: new Map() };
  let currentUserId = null;

  const addUser = (email, name, locale = "fr") => {
    const user = { id: uuid(), email, name, locale, tier: "free", role: "customer", password: "motdepassesolide", createdAt: now() };
    db.users.push(user);
    return user;
  };
  const addMerchant = (owner, data, status = "active") => {
    owner.role = "merchant";
    const merchant = { id: uuid(), ownerId: owner.id, status, moderationNote: "", createdAt: now(), ...data };
    db.merchants.push(merchant);
    return merchant;
  };
  const addService = (merchant, name, durationMin, priceCents, description = "") => {
    const service = { id: uuid(), merchantId: merchant.id, name, description, durationMin, priceCents, active: true };
    db.services.push(service);
    return service;
  };
  const addSlots = (merchant, list, serviceId = null) => {
    let created = 0;
    for (const startsAt of list) {
      if (db.slots.some((s) => s.merchantId === merchant.id && s.startsAt === startsAt && (s.serviceId ?? "") === (serviceId ?? ""))) continue;
      db.slots.push({ id: uuid(), merchantId: merchant.id, serviceId, startsAt, createdAt: now() });
      created++;
    }
    return created;
  };

  // Comptes et fiches de démonstration.
  const wei = addUser("wei@example.com", "Wei", "zh");
  const lin = addUser("studio.lin@example.com", "Lin", "zh");
  const duval = addUser("cabinet.duval@example.com", "Duval");
  const kim = addUser("atelier.kim@example.com", "Kim");
  const nadia = addUser("cours.nadia@example.com", "Nadia");
  const marc = addUser("marc@example.com", "Marc");
  addUser("moderation@drdu.example", "Modération");

  const studio = addMerchant(lin, { name: "Studio Lin", category: "beaute", description: "Coiffure et couleur, équipe bilingue français-chinois. Diagnostic offert avant toute coloration.", address: "5 rue de Belleville", city: "Paris", postalCode: "75020", phone: "01 42 00 12 20", languages: ["Français", "中文"] });
  addService(studio, "Coupe et brushing", 45, 3500, "Diagnostic, coupe, coiffage.");
  addService(studio, "Coloration", 90, 7500, "Couleur professionnelle, soin inclus.");
  addSlots(studio, [at(1, 10), at(1, 11), at(1, 14, 30), at(2, 9), at(2, 16)]);

  const cabinet = addMerchant(duval, { name: "Cabinet Duval", category: "juridique", description: "Conseil en droit du travail et droit des étrangers. Première consultation d'une heure, sur rendez-vous.", address: "12 rue de Turbigo", city: "Paris", postalCode: "75003", phone: "01 44 00 30 10", languages: ["Français", "English"] });
  const consult = addService(cabinet, "Consultation initiale", 60, 9000, "Analyse du dossier et orientation.");
  addService(cabinet, "Relecture de contrat", 45, 7000, "Lecture commentée, points de vigilance.");
  addSlots(cabinet, [at(2, 14), at(2, 15), at(3, 10), at(3, 11)]);

  const atelier = addMerchant(kim, { name: "Atelier Kim", category: "reparation", description: "Retouches et couture sur mesure. Devis gratuit, délais courts, travail sur pièces délicates.", address: "22 rue du Faubourg-du-Temple", city: "Paris", postalCode: "75011", phone: "01 43 00 11 22", languages: ["Français", "한국어", "English"] });
  addService(atelier, "Retouche pantalon", 20, 1800);
  addService(atelier, "Reprise de doublure", 40, 3200);
  addSlots(atelier, [at(1, 10, 30), at(1, 11, 30), at(4, 15), at(4, 16)]);

  const cours = addMerchant(nadia, { name: "Cours Nadia", category: "formation", description: "Cours de français langue étrangère et préparation au TCF. Petits groupes ou individuel.", address: "3 avenue Jean-Jaurès", city: "Lyon", postalCode: "69007", phone: "04 72 00 00 40", languages: ["Français", "العربية", "English"] });
  addService(cours, "Cours individuel FLE", 60, 4000, "Séance sur mesure, tous niveaux.");
  addSlots(cours, [at(2, 18), at(3, 18), at(5, 17)]);

  addMerchant(marc, { name: "Plomberie Marc", category: "reparation", description: "Dépannage et installation sanitaire, interventions rapides sur Paris.", address: "9 rue Oberkampf", city: "Paris", postalCode: "75011", phone: "01 43 00 90 90", languages: ["Français", "English"] }, "pending");

  // Une réservation existante avec un échange, pour montrer la traduction.
  const firstSlot = db.slots.find((s) => s.merchantId === cabinet.id);
  const seedBooking = { id: uuid(), reference: reference(), slotId: firstSlot.id, merchantId: cabinet.id, serviceId: consult.id, customerId: wei.id, startsAt: firstSlot.startsAt, status: "confirmed", note: "我的居留证需要续签，想咨询需要准备哪些材料。", noteLang: "zh", createdAt: now(), cancelledAt: null, cancelledBy: null };
  db.bookings.push(seedBooking);
  db.messages.push({ id: uuid(), bookingId: seedBooking.id, senderId: duval.id, senderRole: "merchant", body: "Bonjour, apportez votre titre de séjour, vos trois derniers bulletins de salaire et un justificatif de domicile.", createdAt: now(), readAt: null });

  /* ---------- Aides ---------- */
  const DEMO_PREFIX = { zh: "【演示译文】", en: "[demo translation] ", fr: "[traduction de démonstration] " };
  const translate = (text, target) => `${DEMO_PREFIX[target] ?? DEMO_PREFIX.fr}${text}`;
  const isAdmin = (user) => Boolean(user) && ADMIN_EMAILS.includes(user.email);
  const publicUser = (u) => u ? { id: u.id, email: u.email, name: u.name, tier: u.tier, role: u.role, locale: u.locale, admin: isAdmin(u), subscriptionStatus: null, currentPeriodEnd: null } : null;
  const inflate = (m) => ({ ...m, categoryLabel: CATEGORIES[m.category] ?? m.category });
  const publicMerchant = (m) => { const { ownerId, moderationNote, ...rest } = inflate(m); return rest; };
  const servicesOf = (merchantId, onlyActive = false) => db.services.filter((s) => s.merchantId === merchantId && (!onlyActive || s.active));
  const isBooked = (slotId) => db.bookings.some((b) => b.slotId === slotId && b.status === "confirmed");
  const available = (merchantId, serviceId = null) => db.slots
    .filter((s) => s.merchantId === merchantId && s.startsAt > now() && !isBooked(s.id) && (!s.serviceId || !serviceId || s.serviceId === serviceId))
    .sort((a, b) => a.startsAt.localeCompare(b.startsAt))
    .map((s) => ({ id: s.id, startsAt: s.startsAt, serviceId: s.serviceId }));
  const slotsForMerchant = (merchantId) => db.slots
    .filter((s) => s.merchantId === merchantId && s.startsAt > now())
    .sort((a, b) => a.startsAt.localeCompare(b.startsAt))
    .map((s) => { const b = db.bookings.find((x) => x.slotId === s.id && x.status === "confirmed"); return { id: s.id, startsAt: s.startsAt, serviceId: s.serviceId, booked: Boolean(b), reference: b?.reference ?? null }; });
  const decorate = (b, readerId) => {
    const m = db.merchants.find((x) => x.id === b.merchantId);
    const s = db.services.find((x) => x.id === b.serviceId);
    const c = db.users.find((x) => x.id === b.customerId);
    return { ...b,
      merchant: m ? { id: m.id, name: m.name, city: m.city, address: m.address, phone: m.phone } : null,
      service: s ? { id: s.id, name: s.name, durationMin: s.durationMin, priceCents: s.priceCents } : null,
      customer: c ? { id: c.id, name: c.name, email: c.email, locale: c.locale } : null,
      unread: db.messages.filter((x) => x.bookingId === b.id && !x.readAt && x.senderId !== readerId).length };
  };
  const merchantOf = (user) => user ? db.merchants.find((m) => m.ownerId === user.id) ?? null : null;
  const normalizeLocale = (l) => Object.hasOwn(LOCALES, l) ? l : "fr";

  const json = (status, body, headers = {}) => new Response(JSON.stringify(body), { status, headers: { "content-type": "application/json", ...headers } });
  const err = (status, error) => json(status, { error });
  const validateMerchant = (b) => {
    const missing = [];
    if (!String(b.name ?? "").trim()) missing.push("nom de l'établissement");
    if (!Object.hasOwn(CATEGORIES, b.category)) missing.push("catégorie");
    if (String(b.description ?? "").trim().length < 20) missing.push("description (20 caractères minimum)");
    if (!String(b.address ?? "").trim()) missing.push("adresse");
    if (!String(b.city ?? "").trim()) missing.push("ville");
    if (!/^[0-9A-Za-z -]{4,12}$/.test(String(b.postalCode ?? ""))) missing.push("code postal");
    if (!/^[+0-9 ().-]{6,30}$/.test(String(b.phone ?? ""))) missing.push("téléphone");
    const languages = (Array.isArray(b.languages) ? b.languages : []).filter(Boolean);
    if (!languages.length) missing.push("langues parlées");
    if (missing.length) throw new Error(`Champs à compléter : ${missing.join(", ")}.`);
    return { name: b.name.trim(), category: b.category, description: b.description.trim(), address: b.address.trim(), city: b.city.trim(), postalCode: String(b.postalCode), phone: String(b.phone), languages };
  };

  /* ---------- Routage ---------- */
  async function handle(method, url, body) {
    const u = new URL(url, "http://preview.local");
    const p = u.pathname;
    const q = u.searchParams;
    const user = db.users.find((x) => x.id === currentUserId) ?? null;
    const requireUser = () => { if (!user) throw Object.assign(new Error("Connexion requise."), { status: 401 }); return user; };
    const requireMerchant = () => { const m = merchantOf(requireUser()); if (!m) throw Object.assign(new Error("Aucun établissement rattaché à ce compte."), { status: 403 }); return m; };
    const requireAdmin = () => { if (!isAdmin(requireUser())) throw Object.assign(new Error("Accès réservé à la modération."), { status: 403 }); };
    const readerLocale = () => normalizeLocale(q.get("lang") ?? user?.locale);

    try {
      if (p === "/api/config") {
        const locale = readerLocale();
        return json(200, { aiMode: "demo", billingMode: "stub", languages: { zh: { label: "中文 (simplifié)" }, en: { label: "English" }, fr: { label: "Français" } }, historyEnabled: false, user: publicUser(user), locale, locales: LOCALES, dictionary: DICTIONARIES[locale], categories: CATEGORIES, merchant: merchantOf(user) ? inflate(merchantOf(user)) : null, moderation: isAdmin(user) ? countStatuses() : null });
      }
      if (p === "/api/auth/signup" && method === "POST") {
        const email = String(body.email ?? "").trim().toLowerCase();
        if (!/^[^@\s]+@[^@\s]+\.[a-z]{2,}$/i.test(email)) return err(400, "Adresse électronique invalide.");
        if (String(body.password ?? "").length < 10) return err(400, "Le mot de passe doit compter au moins 10 caractères.");
        if (db.users.some((x) => x.email === email)) return err(409, "Un compte existe déjà pour cette adresse.");
        const created = addUser(email, String(body.name ?? "").trim() || email.split("@")[0]);
        created.password = body.password;
        currentUserId = created.id;
        return json(201, { user: publicUser(created) });
      }
      if (p === "/api/auth/login" && method === "POST") {
        const found = db.users.find((x) => x.email === String(body.email ?? "").trim().toLowerCase());
        if (!found || found.password !== body.password) return err(401, "Adresse ou mot de passe incorrect.");
        currentUserId = found.id;
        return json(200, { user: publicUser(found) });
      }
      if (p === "/api/auth/logout") { currentUserId = null; return json(200, { ok: true }); }
      if (p === "/api/auth/me") return json(200, { user: publicUser(user) });
      if (p === "/api/auth/forgot") return json(200, { ok: true, message: "Si un compte existe pour cette adresse, un lien vient d'être envoyé. (Prévisualisation : aucun courriel ne part.)" });
      if (p === "/api/auth/reset") return err(400, "Lien invalide ou expiré. Demandez-en un nouveau.");
      if (p === "/api/locale" && method === "PUT") { requireUser(); user.locale = normalizeLocale(body.locale); return json(200, { locale: user.locale, dictionary: DICTIONARIES[user.locale] }); }

      if (p === "/api/catalog") {
        const city = q.get("ville"), category = q.get("categorie");
        const list = db.merchants.filter((m) => m.status === "active" && (!city || m.city.toLowerCase() === city.toLowerCase()) && (!category || m.category === category))
          .sort((a, b) => a.name.localeCompare(b.name))
          .map((m) => ({ ...publicMerchant(m), services: servicesOf(m.id, true), openSlots: available(m.id).length }));
        const cities = [...new Set(db.merchants.filter((m) => m.status === "active").map((m) => m.city))];
        return json(200, { categories: CATEGORIES, cities, merchants: list });
      }
      let match;
      if ((match = p.match(/^\/api\/merchants\/([^/]+)$/)) && method === "GET") {
        const m = db.merchants.find((x) => x.id === match[1]);
        if (!m || m.status !== "active") return err(404, "Établissement introuvable.");
        return json(200, { merchant: publicMerchant(m), services: servicesOf(m.id, true), slots: available(m.id, q.get("prestation") || null) });
      }
      if (p === "/api/merchants" && method === "POST") {
        requireUser();
        if (merchantOf(user)) return err(409, "Un établissement est déjà rattaché à ce compte.");
        const created = addMerchant(user, validateMerchant(body), AUTO_APPROVE ? "active" : "pending");
        return json(201, { merchant: inflate(created) });
      }
      if (p === "/api/merchant/me") {
        const m = requireMerchant();
        if (method === "PUT") {
          Object.assign(m, validateMerchant(body));
          if (m.status === "rejected") { m.status = AUTO_APPROVE ? "active" : "pending"; m.moderationNote = ""; }
        }
        return json(200, { merchant: inflate(m), services: servicesOf(m.id), slots: slotsForMerchant(m.id) });
      }
      if (p === "/api/merchant/visibility" && method === "PUT") {
        const m = requireMerchant();
        if (!["active", "paused"].includes(m.status)) return err(409, m.status === "pending" ? "Votre fiche attend encore la validation de la modération." : m.status === "suspended" ? "Votre fiche a été suspendue par la modération : contactez-nous pour la rétablir." : "Votre fiche a été refusée : corrigez-la, elle repassera en validation.");
        m.status = body.visible === false ? "paused" : "active";
        return json(200, { merchant: inflate(m) });
      }
      if (p === "/api/merchant/bookings") {
        const m = requireMerchant(); const target = readerLocale();
        const list = db.bookings.filter((b) => b.merchantId === m.id).sort((a, b) => a.startsAt.localeCompare(b.startsAt))
          .map((b) => ({ ...decorate(b, user.id), noteTranslation: b.note && b.noteLang !== target ? translate(b.note, target) : null }));
        return json(200, { bookings: list, target });
      }
      if (p === "/api/merchant/services" && method === "POST") {
        const m = requireMerchant();
        const d = Number(body.durationMin), price = Math.round(Number(body.priceCents ?? 0));
        if (!String(body.name ?? "").trim() || !Number.isInteger(d) || d < 5 || !Number.isInteger(price) || price < 0) return err(400, "Champs à compléter : nom de la prestation, durée (5 à 600 minutes), prix.");
        return json(201, { service: addService(m, body.name.trim(), d, price, String(body.description ?? "")) });
      }
      if ((match = p.match(/^\/api\/merchant\/services\/([^/]+)$/))) {
        const m = requireMerchant(); const s = db.services.find((x) => x.id === match[1] && x.merchantId === m.id);
        if (!s) return err(404, "Prestation introuvable.");
        if (method === "PUT") { Object.assign(s, { name: body.name, description: body.description ?? "", durationMin: Number(body.durationMin), priceCents: Math.round(Number(body.priceCents)), active: body.active !== false }); return json(200, { service: s }); }
        if (method === "DELETE") {
          const total = db.bookings.filter((b) => b.serviceId === s.id).length;
          if (total) return err(409, `Cette prestation a ${total} réservation(s) dans l'historique des clients : désactivez-la plutôt que de la supprimer.`);
          db.services = db.services.filter((x) => x !== s); return json(200, { ok: true });
        }
      }
      if (p === "/api/merchant/slots" && method === "POST") {
        const m = requireMerchant();
        const list = (Array.isArray(body.startsAt) ? body.startsAt : []).map((v) => new Date(v)).filter((d) => !Number.isNaN(d) && d.getTime() > Date.now()).map((d) => d.toISOString());
        if (!list.length) return err(400, "Aucun créneau valide à venir.");
        return json(201, { created: addSlots(m, list, body.serviceId || null), slots: slotsForMerchant(m.id) });
      }
      if ((match = p.match(/^\/api\/merchant\/slots\/([^/]+)$/)) && method === "DELETE") {
        const m = requireMerchant(); const s = db.slots.find((x) => x.id === match[1] && x.merchantId === m.id);
        if (!s) return err(404, "Créneau introuvable.");
        if (isBooked(s.id)) return err(409, "Ce créneau est réservé : annulez la réservation d'abord.");
        db.slots = db.slots.filter((x) => x !== s); return json(200, { ok: true });
      }

      if (p === "/api/bookings" && method === "POST") {
        requireUser();
        const slot = db.slots.find((x) => x.id === body.slotId);
        if (!slot) return err(404, "Créneau introuvable.");
        const m = db.merchants.find((x) => x.id === slot.merchantId);
        if (!m || m.status !== "active") return err(409, "Cet établissement n'accepte pas de réservation pour le moment.");
        const s = db.services.find((x) => x.id === body.serviceId && x.merchantId === m.id && x.active);
        if (!s) return err(400, "Prestation indisponible.");
        if (isBooked(slot.id)) return err(409, "Ce créneau vient d'être réservé.");
        const b = { id: uuid(), reference: reference(), slotId: slot.id, merchantId: m.id, serviceId: s.id, customerId: user.id, startsAt: slot.startsAt, status: "confirmed", note: String(body.note ?? "").slice(0, 1000), noteLang: normalizeLocale(body.noteLang ?? user.locale), createdAt: now(), cancelledAt: null, cancelledBy: null };
        db.bookings.push(b);
        return json(201, { booking: decorate(b, user.id) });
      }
      if (p === "/api/bookings" && method === "GET") {
        requireUser();
        return json(200, { bookings: db.bookings.filter((b) => b.customerId === user.id).sort((a, b) => b.startsAt.localeCompare(a.startsAt)).map((b) => decorate(b, user.id)) });
      }
      if ((match = p.match(/^\/api\/bookings\/([^/]+)\/cancel$/)) && method === "POST") {
        requireUser(); const b = db.bookings.find((x) => x.id === match[1]); const m = merchantOf(user);
        if (!b || !(b.customerId === user.id || (m && b.merchantId === m.id))) return err(404, "Réservation introuvable.");
        if (b.status === "confirmed") { b.status = "cancelled"; b.cancelledAt = now(); b.cancelledBy = b.customerId === user.id ? "customer" : "merchant"; }
        return json(200, { booking: decorate(b, user.id) });
      }
      if ((match = p.match(/^\/api\/bookings\/([^/]+)\/messages$/))) {
        requireUser(); const b = db.bookings.find((x) => x.id === match[1]); const m = merchantOf(user);
        const role = b && b.customerId === user.id ? "customer" : b && m && b.merchantId === m.id ? "merchant" : null;
        if (!role) return err(404, "Réservation introuvable.");
        if (method === "POST") {
          const text = String(body.body ?? "").trim();
          if (!text) return err(400, "Message vide.");
          const msg = { id: uuid(), bookingId: b.id, senderId: user.id, senderRole: role, body: text, createdAt: now(), readAt: null };
          db.messages.push(msg); return json(201, { id: msg.id, createdAt: msg.createdAt });
        }
        const target = readerLocale();
        const list = db.messages.filter((x) => x.bookingId === b.id).map((x) => ({ id: x.id, mine: x.senderId === user.id, senderRole: x.senderRole, body: x.body, translation: x.senderId === user.id ? null : translate(x.body, target), createdAt: x.createdAt }));
        for (const x of db.messages) if (x.bookingId === b.id && x.senderId !== user.id) x.readAt = now();
        return json(200, { messages: list, target, role });
      }

      if (p === "/api/translate" && method === "POST") {
        const tier = user?.tier === "member" ? "member" : "free";
        const target = Object.hasOwn(LOCALES, body.target) ? body.target : "zh";
        const d = DEMO_TRANSLATION[target] ?? DEMO_TRANSLATION.zh;
        const base = { tier, target, fileName: body.fileName ?? "document", document_type: d.document_type, translation: d.translation, mode: "demo", historyId: null };
        return json(200, tier === "member" ? { ...base, ...d.member } : { ...base, summary: "", cautions: [], glossary: [], questions_for_doctor: [], follow_up: [] });
      }
      if (p === "/api/history") return err(404, "La conservation des documents est désactivée sur ce service.");
      if (p === "/api/billing/checkout" && method === "POST") { requireUser(); if (user.tier === "member") return err(409, "Votre formule Membre est déjà active."); user.tier = "member"; return json(200, { mode: "stub", user: publicUser(user) }); }
      if (p === "/api/billing/portal" && method === "POST") { requireUser(); user.tier = "free"; return json(200, { mode: "stub", user: publicUser(user) }); }

      if (p === "/api/admin/merchants" && method === "GET") {
        requireAdmin(); const status = q.get("statut");
        const list = db.merchants.filter((m) => !status || m.status === status)
          .sort((a, b) => (a.status === "pending" ? 0 : 1) - (b.status === "pending" ? 0 : 1))
          .map((m) => { const o = db.users.find((x) => x.id === m.ownerId); return { ...inflate(m), reviewedAt: null, owner: o ? { name: o.name, email: o.email } : null, services: servicesOf(m.id).length }; });
        return json(200, { merchants: list, counts: countStatuses(), statuses: ["pending", "active", "paused", "suspended", "rejected"] });
      }
      if ((match = p.match(/^\/api\/admin\/merchants\/([^/]+)$/)) && method === "PUT") {
        requireAdmin(); const m = db.merchants.find((x) => x.id === match[1]);
        if (!m) return err(404, "Établissement introuvable.");
        if (!["pending", "active", "paused", "suspended", "rejected"].includes(body.status)) return err(400, "Statut inconnu.");
        if (body.status === "rejected" && !String(body.note ?? "").trim()) return err(400, "Un refus doit être motivé : le commerçant doit savoir quoi corriger.");
        m.status = body.status; m.moderationNote = String(body.note ?? "");
        return json(200, { merchant: inflate(m) });
      }
      if (p.startsWith("/api/")) return err(404, "Route inconnue.");
      return null;
    } catch (error) {
      return err(error.status ?? 400, error.message);
    }
  }
  function countStatuses() { return db.merchants.reduce((acc, m) => ((acc[m.status] = (acc[m.status] ?? 0) + 1), acc), {}); }

  const realFetch = window.fetch.bind(window);
  window.fetch = async (input, init = {}) => {
    const url = typeof input === "string" ? input : input.url;
    if (!url.startsWith("/api/")) return realFetch(input, init);
    const body = init.body ? JSON.parse(init.body) : {};
    // Un léger délai rend visible l'état de chargement, comme un vrai réseau.
    await new Promise((r) => setTimeout(r, 60));
    return handle((init.method ?? "GET").toUpperCase(), url, body);
  };
})();
