(function (window, document) {
  'use strict';

  var measurementId = 'G-XFS3JB78EJ';

  window.dataLayer = window.dataLayer || [];
  window.gtag = window.gtag || function () {
    window.dataLayer.push(arguments);
  };

  window.gtag('js', new Date());
  window.gtag('config', measurementId);

  document.addEventListener('click', function (event) {
    var target = event.target && event.target.closest
      ? event.target.closest('[data-goal]')
      : null;

    if (!target) return;

    var goal = String(target.getAttribute('data-goal') || '').trim();
    if (!/^[A-Za-z][A-Za-z0-9_]{0,39}$/.test(goal)) return;

    window.gtag('event', goal, {
      event_category: 'engagement',
      link_url: target.href || undefined
    });
  });
})(window, document);
