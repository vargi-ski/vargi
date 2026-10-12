(function (root) {
  'use strict';
  var rooms = {double:'Двухместный коттедж · полный пакет от 115 000 ₽',single:'Одноместное · стоимость по запросу',family:'Семейное · стоимость по запросу',suite:'Люкс с собственной сауной · по запросу',help:'Нужна помощь с размещением'};
  var levels = {beginner:'Начинаю / небольшой опыт',amateur:'Тренируюсь регулярно',marathon:'Есть опыт лыжных марафонов',sport:'Соревнующийся спортсмен',discuss:'Хочу обсудить с тренером'};
  var formBase = 'https://forms.yandex.ru/u/6aacf2a849af472ed76c9d3d';
  function buildMessage(data) {
    var count = Number(data.participants);
    if (!Object.prototype.hasOwnProperty.call(rooms,data.room) || !Object.prototype.hasOwnProperty.call(levels,data.level) || !Number.isInteger(count) || count < 1 || count > 20) throw new Error('Выберите размещение, уровень и количество участников от 1 до 20.');
    var comment = String(data.comment || '').trim();
    if (comment.length > 500) throw new Error('Сократите комментарий до 500 символов.');
    return ['ЗАЯВКА НА КЕМП ВАРГИ — ВКАТКА 2026','Мурманск · 26 ноября — 5 декабря 2026','Проживание: «Акора», Долина Уюта','', 'Размещение: '+rooms[data.room], 'Планирует приехать: '+count, 'Уровень подготовки: '+levels[data.level], comment ? 'Пожелания: '+comment : '', '', 'Полный пакет с двухместным размещением — от 115 000 ₽. Стоимость других вариантов и участия сопровождающих согласуется отдельно.', 'Прошу связаться со мной для согласования участия. Место и условия требуют личного подтверждения.'].filter(function(v){return v!=='';}).join('\n');
  }
  function linksFor(message) {
    var direct = new URL(formBase); direct.searchParams.set('theme','dark'); direct.searchParams.set('answer_choices_96193','85177'); direct.searchParams.set('vargi_camp','first-snow-2026'); direct.searchParams.set('message',message);
    var embedded = new URL(direct.href); embedded.searchParams.set('iframe','1');
    var telegram = new URL('https://t.me/TomMurman'); telegram.searchParams.set('text',message);
    return {direct:direct.href,embedded:embedded.href,telegram:telegram.href};
  }
  if (typeof module === 'object' && module.exports) module.exports = {buildMessage:buildMessage,linksFor:linksFor};
  if (!root.document) return;
  var doc = root.document, builder = doc.getElementById('campBuilder');
  if (!builder) return;
  var checkout = doc.getElementById('campCheckout'), lastMessage = '';
  var room = doc.getElementById('campRoom'), count = doc.getElementById('campParticipants'), level = doc.getElementById('campLevel'), comment = doc.getElementById('campComment');
  // Only non-identifying choices are kept for this tab. Contact data belongs to the embedded form.
  var draftKey = 'vargi-camp-2026-preferences';
  function remember() {try {root.sessionStorage.setItem(draftKey,JSON.stringify({room:room.value,participants:count.value,level:level.value}));} catch (_) {}}
  try {var saved=JSON.parse(root.sessionStorage.getItem(draftKey)||'null');if(saved){if(rooms[saved.room])room.value=saved.room;if(levels[saved.level])level.value=saved.level;var n=Number(saved.participants);if(Number.isInteger(n)&&n>=1&&n<=20)count.value=n;}} catch (_) {}
  builder.hidden = false;
  [room,count,level].forEach(function(field){field.addEventListener('change',remember);});
  builder.addEventListener('submit',function(event){
    event.preventDefault(); var error=doc.getElementById('campError'); error.hidden=true;
    if(!builder.reportValidity())return;
    var message;
    try {message=buildMessage({room:room.value,participants:count.value,level:level.value,comment:comment.value});} catch(e){error.textContent=e.message;error.hidden=false;return;}
    if(lastMessage && lastMessage!==message && !root.confirm('Условия изменились. Форму контактов нужно обновить — введённые в ней данные потребуется указать заново. Продолжить?'))return;
    var urls=linksFor(message);
    doc.getElementById('campSummary').textContent=message;
    doc.getElementById('openCampForm').href=urls.direct;
    doc.getElementById('telegramCamp').href=urls.telegram;
    if(message!==lastMessage)doc.getElementById('campForm').src=urls.embedded;
    lastMessage=message; remember(); builder.hidden=true; checkout.hidden=false;
    doc.getElementById('checkoutHeading').focus();
    checkout.scrollIntoView({block:'start',behavior:'auto'});
  });
  doc.getElementById('editCamp').addEventListener('click',function(){checkout.hidden=true;builder.hidden=false;room.focus();builder.scrollIntoView({block:'start',behavior:'auto'});});
})(typeof window === 'undefined' ? globalThis : window);
