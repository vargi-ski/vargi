(function () {
  'use strict';
  var base = 'https://forms.yandex.ru/u/6aacf2a849af472ed76c9d3d';
  var roles = {main:'9008994414934774',expanded:'1795160263095',community:'1795160271723'};
  var requested = new URLSearchParams(window.location.search).get('format');
  var form = new URL(base);
  form.searchParams.set('theme', 'dark');
  // Yandex restores unfinished answers by form ID unless this cache is isolated.
  form.searchParams.set('form:cache_key', 'vargi-join-v1');
  form.searchParams.set('vargi_camp', 'contact');
  form.searchParams.set('vargi_join', '1');
  form.searchParams.set('answer_choices_96193', '85175');
  form.searchParams.set('answer_choices_9008994414934764', Object.hasOwn(roles,requested) ? roles[requested] : '');
  form.searchParams.set('message', '');
  document.getElementById('openJoinForm').href = form.href;
  form.searchParams.set('iframe', '1');
  document.getElementById('joinForm').src = form.href;
})();
