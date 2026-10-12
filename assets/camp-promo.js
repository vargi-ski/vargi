/* VARGI camp campaign. Self-contained and safe on pages without this campaign. */
(function (root) {
  'use strict';

  const CAMPAIGN = 'vargi-camp-murmansk-2026';
  const DISMISS_KEY = CAMPAIGN + ':dismissed-at';
  const END_AT = Date.parse('2026-11-26T00:00:00+03:00');
  const COOLDOWN = 24 * 60 * 60 * 1000;
  const CAMP_URL = '/camps/first-snow/';

  function isActive(now) {
    return Number.isFinite(now) && now < END_AT;
  }

  function isDismissed(value, now) {
    const dismissedAt = Number(value);
    return dismissedAt > 0 && Number.isFinite(dismissedAt) && now - dismissedAt < COOLDOWN;
  }

  function isExcluded(pathname, hash) {
    const path = String(pathname || '/').toLowerCase();
    return /^\/camps\/first-snow(?:\/|$)/.test(path) ||
      /(?:^|\/)(?:admin|submit|order|signup|contact|privacy|privacy-policy|analytics-dashboard|analytics)(?:\/|\.|$)/.test(path) ||
      /(?:signup|application|registration|form|message=|заявк)/i.test(String(hash || ''));
  }

  // The predicates can be checked without loading a browser or a DOM.
  if (typeof module !== 'undefined' && module.exports) {
    module.exports = { isActive, isDismissed, isExcluded, END_AT, COOLDOWN };
  }
  if (!root || !root.document) return;

  const doc = root.document;
  if (root.__vargiCampPromoInitialized) return;
  root.__vargiCampPromoInitialized = true;
  let memoryDismissedAt = 0;
  let banner;
  let dialog;
  let expiryTimer;

  function wasDismissed() {
    if (isDismissed(memoryDismissedAt, Date.now())) return true;
    for (const storeName of ['localStorage', 'sessionStorage']) {
      try {
        if (isDismissed(root[storeName].getItem(DISMISS_KEY), Date.now())) return true;
      } catch (_) { /* Private or restricted browsers can disable storage. */ }
    }
    return false;
  }

  function rememberDismissal() {
    memoryDismissedAt = Date.now();
    for (const storeName of ['localStorage', 'sessionStorage']) {
      try { root[storeName].setItem(DISMISS_KEY, String(memoryDismissedAt)); } catch (_) { /* Memory is enough for this page. */ }
    }
  }

  function create(tag, className, text) {
    const element = doc.createElement(tag);
    if (className) element.className = className;
    if (text) element.textContent = text;
    return element;
  }

  function campLink(className, text) {
    const link = create('a', className, text);
    link.href = CAMP_URL;
    return link;
  }

  function teardown() {
    root.clearTimeout(expiryTimer);
    if (dialog && dialog.open) dialog.close();
    if (dialog) dialog.remove();
    if (banner) banner.remove();
    doc.removeEventListener('visibilitychange', checkExpiry);
  }

  function checkExpiry() {
    if (!isActive(Date.now())) {
      teardown();
      return;
    }
    root.clearTimeout(expiryTimer);
    // Also retires the campaign in a tab left open across the start date.
    expiryTimer = root.setTimeout(checkExpiry, Math.min(END_AT - Date.now(), 60 * 60 * 1000));
  }

  function addBanner() {
    banner = create('aside', 'vargi-camp-banner');
    banner.setAttribute('aria-label', 'Лыжный кемп ВАРГИ в Мурманске');
    const inner = create('div', 'vargi-camp-banner__inner');
    const info = create('div', 'vargi-camp-banner__info');
    info.append(
      create('strong', 'vargi-camp-banner__title', 'Вкатка 2026 · Мурманск'),
      create('span', 'vargi-camp-banner__dates', '26 ноября — 5 декабря · от 115 000 ₽')
    );
    inner.append(info, campLink('vargi-camp-banner__link', 'Север зовёт своих →'));
    banner.append(inner);
    const main = doc.querySelector('main');
    const header = doc.querySelector('body > header');
    if (main) {
      main.prepend(banner);
    } else if (header) {
      // The homepage header is fixed; retain its space above the inline banner.
      if (root.getComputedStyle(header).position === 'fixed') {
        banner.style.marginTop = Math.ceil(header.getBoundingClientRect().height) + 'px';
      }
      header.after(banner);
    } else {
      doc.body.prepend(banner);
    }
  }

  function visitorIsBusy() {
    const active = doc.activeElement;
    const editing = active && (active.matches('input, textarea, select, [contenteditable]:not([contenteditable="false"])') || active.isContentEditable);
    return editing || doc.hidden || Boolean(doc.querySelector('dialog[open], .overlay.show, [aria-modal="true"]:not([hidden]), #burger[aria-expanded="true"]'));
  }

  function showPromo() {
    // One attempt only: never interrupt someone who has already opened a form,
    // menu or product dialog while this page was loading.
    if (!isActive(Date.now()) || wasDismissed() || visitorIsBusy() || isExcluded(root.location.pathname, root.location.hash)) return;
    dialog = create('dialog', 'vargi-camp-promo');
    if (typeof dialog.showModal !== 'function') return; // Inline banner remains available.
    dialog.setAttribute('aria-labelledby', 'vargi-camp-promo-title');
    dialog.setAttribute('aria-describedby', 'vargi-camp-promo-summary');

    const closeButton = create('button', 'vargi-camp-promo__close', '×');
    closeButton.type = 'button';
    closeButton.autofocus = true;
    closeButton.setAttribute('aria-label', 'Закрыть анонс кемпа');
    const layout = create('div', 'vargi-camp-promo__layout');
    const photo = create('img', 'vargi-camp-promo__photo');
    photo.src = '/assets/camp-2026/16.jpg';
    photo.alt = '';
    photo.loading = 'lazy';
    photo.decoding = 'async';
    photo.width = 640;
    photo.height = 800;
    const content = create('div', 'vargi-camp-promo__content');
    const title = create('h2', 'vargi-camp-promo__title', 'Север зовёт своих');
    title.id = 'vargi-camp-promo-title';
    const summary = create('p', 'vargi-camp-promo__summary', '10 дней на снегу: тренировки со стаей, коттеджи в Долине Уюта и северные приключения.');
    summary.id = 'vargi-camp-promo-summary';
    const price = create('p', 'vargi-camp-promo__price');
    price.append(create('strong', '', 'от 115 000 ₽'), create('span', '', 'Полный пакет · двухместное размещение'));
    const action = campLink('vargi-camp-promo__action', 'Программа и заявка');
    action.addEventListener('click', rememberDismissal);
    content.append(
      create('p', 'vargi-camp-promo__eyebrow', 'ВАРГИ · ВКАТКА 2026'),
      title,
      create('p', 'vargi-camp-promo__location', 'Мурманск'),
      create('p', 'vargi-camp-promo__dates', '26 ноября — 5 декабря'),
      summary, price, action
    );
    layout.append(photo, content);
    dialog.append(closeButton, layout);
    const previouslyFocused = doc.activeElement;
    closeButton.addEventListener('click', () => dialog.close());
    let pointerStartedOutside = false;
    const outsideBounds = (event) => {
      const bounds = dialog.getBoundingClientRect();
      return event.clientX < bounds.left || event.clientX > bounds.right || event.clientY < bounds.top || event.clientY > bounds.bottom;
    };
    dialog.addEventListener('pointerdown', (event) => { pointerStartedOutside = event.target === dialog && outsideBounds(event); });
    dialog.addEventListener('click', (event) => {
      if (pointerStartedOutside && event.target === dialog && outsideBounds(event)) dialog.close();
      pointerStartedOutside = false;
    });
    // Escape uses the native dialog cancel/close behavior and focus containment.
    dialog.addEventListener('close', () => {
      rememberDismissal();
      if (previouslyFocused && previouslyFocused.isConnected && previouslyFocused !== doc.body && typeof previouslyFocused.focus === 'function') {
        previouslyFocused.focus({ preventScroll: true });
      }
      dialog.remove();
    }, { once: true });
    doc.body.append(dialog);
    try { dialog.showModal(); } catch (_) { dialog.remove(); }
  }

  function init() {
    if (!isActive(Date.now()) || isExcluded(root.location.pathname, root.location.hash)) return;
    addBanner();
    root.setTimeout(showPromo, 1200);
    doc.addEventListener('visibilitychange', checkExpiry);
    checkExpiry();
  }

  if (doc.readyState === 'loading') doc.addEventListener('DOMContentLoaded', init, { once: true });
  else init();
})(typeof window !== 'undefined' ? window : null);
