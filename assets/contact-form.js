(function () {
  'use strict';
  var base = 'https://forms.yandex.ru/u/6aacf2a849af472ed76c9d3d';
  var params = new URLSearchParams(window.location.hash.slice(1));
  var message = (params.get('message') || '').slice(0, 3500);
  var form = new URL(base);
  form.searchParams.set('theme', 'dark');
  // Keep prefills (including board ads) out of the plain contact/join drafts.
  form.searchParams.set('form:cache_key', message ? 'vargi-contact-prefill-v1' : 'vargi-contact-v1');
  form.searchParams.set('vargi_camp', 'contact');
  form.searchParams.set('vargi_join', '');
  form.searchParams.set('answer_choices_9008994414934764', '');
  form.searchParams.set('answer_choices_96193', '');
  form.searchParams.set('message', message);
  document.getElementById('openForm').href = form.href;
  form.searchParams.set('iframe', '1');
  document.getElementById('contactForm').src = form.href;
  var telegram = new URL('https://t.me/TomMurman');
  if (message) telegram.searchParams.set('text', message);
  document.getElementById('telegramContact').href = telegram.href;
})();

