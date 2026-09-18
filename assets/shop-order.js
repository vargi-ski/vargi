(function () {
  'use strict';
  var catalog = (window.VARGI_SHOP || []).filter(function (p) { return p.available && !p.soon; });
  var formBase = 'https://forms.yandex.ru/u/6aad189e84227c2dd4dbd7a6';
  var builder = document.getElementById('orderBuilder');
  var items = document.getElementById('orderItems');
  var checkout = document.getElementById('orderCheckout');
  var addButton = document.getElementById('addItem');
  var lastMessage = '';
  var money = new Intl.NumberFormat('ru-RU');
  var template = document.getElementById('orderItemTemplate');
  if (!catalog.length) return;
  function rub(value) { return money.format(value) + ' ₽'; }
  function productFor(row) { return catalog.find(function (p) { return p.id === row.querySelector('.product').value; }); }
  function rows() { return Array.from(items.querySelectorAll('.order-item')); }
  function quantityFor(row) {
    var value = row.querySelector('.quantity').valueAsNumber;
    return Number.isInteger(value) && value >= 1 && value <= 99 ? value : null;
  }
  function refresh() {
    var total = 0;
    var valid = true;
    var all = rows();
    all.forEach(function (row, index) {
      var product = productFor(row);
      var quantity = quantityFor(row);
      row.querySelector('legend').textContent = 'Товар ' + (index + 1);
      row.querySelector('.remove').disabled = all.length === 1;
      row.querySelector('.remove').setAttribute('aria-label', 'Убрать товар ' + (index + 1));
      row.querySelector('.item-price').textContent = quantity === null ? 'Укажите количество' : 'от ' + rub(product.basePrice * quantity);
      if (quantity === null) valid = false;
      else total += product.basePrice * quantity;
    });
    document.getElementById('orderTotal').textContent = valid ? 'от ' + rub(total) : '—';
    addButton.disabled = all.length >= 10;
  }
  function setProduct(row) {
    var product = productFor(row);
    var photo = row.querySelector('.product-photo');
    photo.src = product.img;
    photo.alt = product.name;
    photo.style.backgroundColor = product.bg || '#0b1015';
    row.querySelector('.product-material').textContent = product.material || product.desc;
    row.querySelector('.size-label span').textContent = product.sizeKind === 'cap' ? 'Обхват головы, см' : 'Желаемый размер';
    row.querySelector('.size').placeholder = product.sizeKind === 'cap' ? 'Например, 58' : 'Например, M или 48';
    row.querySelector('.size').value = '';
    row.querySelector('.help-size').checked = false;
    row.querySelector('.size').disabled = false;
    row.querySelector('.size').required = true;
    refresh();
  }
  function addItem(productId, focus) {
    if (rows().length >= 10) return;
    var row = template.content.firstElementChild.cloneNode(true);
    var select = row.querySelector('.product');
    catalog.forEach(function (p) {
      var option = document.createElement('option');
      option.value = p.id;
      option.textContent = p.name + ' · ' + p.price;
      select.appendChild(option);
    });
    if (catalog.some(function (p) { return p.id === productId; })) select.value = productId;
    items.appendChild(row);
    select.addEventListener('change', function () { setProduct(row); });
    row.querySelector('.quantity').addEventListener('input', refresh);
    row.querySelector('.size').addEventListener('input', function () { this.setCustomValidity(''); });
    row.querySelector('.help-size').addEventListener('change', function () {
      var size = row.querySelector('.size');
      size.disabled = this.checked;
      size.required = !this.checked;
      size.setCustomValidity('');
    });
    row.querySelector('.remove').addEventListener('click', function () {
      if (rows().length <= 1) return;
      row.remove(); refresh(); addButton.focus();
    });
    setProduct(row);
    if (focus) select.focus();
  }
  addButton.addEventListener('click', function () { addItem(catalog[0].id, true); });
  builder.addEventListener('submit', function (event) {
    event.preventDefault();
    var error = document.getElementById('orderError');
    error.hidden = true;
    var order = [];
    for (var row of rows()) {
      var product = productFor(row);
      var quantity = quantityFor(row);
      var sizeInput = row.querySelector('.size');
      var helpSize = row.querySelector('.help-size').checked;
      var size = helpSize ? 'Нужна помощь с размером' : sizeInput.value.trim();
      if (!size) { sizeInput.setCustomValidity('Укажите размер или выберите помощь с подбором.'); sizeInput.reportValidity(); return; }
      if (!product || quantity === null) { builder.reportValidity(); return; }
      order.push({product:product, quantity:quantity, size:size});
    }
    if (!order.length || !builder.reportValidity()) return;
    var total = order.reduce(function (sum, line) { return sum + line.product.basePrice * line.quantity; }, 0);
    var lines = order.map(function (line, index) {
      var sizeLabel = line.product.sizeKind === 'cap' ? 'обхват головы' : 'размер';
      return (index + 1) + '. ' + line.product.name + ' — ' + sizeLabel + ': ' + line.size + '; ' + line.quantity + ' шт. × от ' + rub(line.product.basePrice) + ' = от ' + rub(line.product.basePrice * line.quantity);
    });
    var message = ['ЗАКАЗ ЭКИПИРОВКИ ВАРГИ', '', lines.join('\n'), '', 'Предварительная стоимость товаров: от ' + rub(total) + '.', 'Доставка не включена. Наличие, окончательная стоимость и оплата — после согласования.', '', 'Комментарий к заказу (если нужен):'].join('\n');
    if (message.length > 6000) { error.textContent = 'Сократите описание размеров и повторите оформление.'; error.hidden = false; return; }
    if (lastMessage && message !== lastMessage && !window.confirm('Состав заказа изменился. Контакты в форме потребуется заполнить заново. Обновить заказ?')) return;
    var summary = document.getElementById('summaryItems'); summary.replaceChildren();
    lines.forEach(function (line) { var li = document.createElement('li'); li.textContent = line; summary.appendChild(li); });
    document.getElementById('summaryTotal').textContent = 'Товары: от ' + rub(total);
    var url = new URL(formBase);
    url.searchParams.set('theme', 'dark');
    url.searchParams.set('message', message);
    document.getElementById('openOrderForm').href = url.href;
    url.searchParams.set('iframe', '1');
    if (message !== lastMessage) document.getElementById('orderForm').src = url.href;
    var telegram = new URL('https://t.me/TomMurman'); telegram.searchParams.set('text', message);
    document.getElementById('telegramOrder').href = telegram.href;
    lastMessage = message;
    builder.hidden = true; checkout.hidden = false;
    document.getElementById('checkoutHeading').focus();
  });
  document.getElementById('editOrder').addEventListener('click', function () {
    checkout.hidden = true; builder.hidden = false;
    items.querySelector('.product').focus();
  });
  addItem(new URLSearchParams(window.location.search).get('product'), false);
  builder.hidden = false;
})();
