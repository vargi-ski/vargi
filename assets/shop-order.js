(function (root) {
  'use strict';
  function parseMeasurement(value) {
    var text = String(value || '').trim();
    if (!text) return null;
    if (!/^\d{1,3}(?:[.,]\d)?$/.test(text)) return NaN;
    var number = Number(text.replace(',', '.'));
    return number >= 1 && number <= 300 ? number : NaN;
  }
  function resolveSize(product, size, help, measurements) {
    if (help) return 'Нужна помощь с размером';
    if (String(size || '').trim()) return String(size).trim();
    if (product.preorder && !product.stock && product.sizeKind === 'clothing' && measurements.some(Number.isFinite)) {
      return 'Подобрать по указанным меркам';
    }
    return '';
  }
  function readDraft(raw, catalog, now) {
    try {
      var draft = JSON.parse(raw);
      if (!draft || draft.version !== 1 || !Number.isFinite(draft.updatedAt) || now - draft.updatedAt > 86400000 || draft.updatedAt > now || !Array.isArray(draft.items) || !draft.items.length || draft.items.length > 10) return null;
      var clean = draft.items.filter(function (line) { return line && catalog.some(function (p) { return p.id === line.product; }); }).map(function (line) {
        function text(value, limit) { return typeof value === 'string' ? value.slice(0, limit) : ''; }
        return {product:line.product, size:text(line.size, 40), quantity:text(line.quantity, 8), help:line.help === true, measurements:[0,1,2,3].map(function (index) { return text(Array.isArray(line.measurements) ? line.measurements[index] : '', 20); })};
      });
      return clean.length ? clean : null;
    } catch (_) { return null; }
  }
  if (typeof module === 'object' && module.exports) module.exports = {parseMeasurement:parseMeasurement, resolveSize:resolveSize, readDraft:readDraft};
  if (!root.document) return;
  var document = root.document;
  var catalog = (window.VARGI_SHOP || []).filter(function (p) { return (p.available || p.preorder) && !p.soon; });
  var formBase = 'https://forms.yandex.ru/u/6aad189e84227c2dd4dbd7a6';
  var builder = document.getElementById('orderBuilder');
  var items = document.getElementById('orderItems');
  var checkout = document.getElementById('orderCheckout');
  var addButton = document.getElementById('addItem');
  var lastMessage = '';
  var nextItemId = 0;
  var money = new Intl.NumberFormat('ru-RU');
  var template = document.getElementById('orderItemTemplate');
  if (!catalog.length) return;
  var initialParams = new URLSearchParams(window.location.search);
  var draftKey = 'vargi-shop-order-v1:' + (initialParams.get('product') || '') + ':' + (initialParams.get('size') || '');
  var ready = false;
  // Own validation avoids the browser jumping up to an unexplained required field.
  builder.noValidate = true;
  function rub(value) { return money.format(value) + ' ₽'; }
  function productFor(row) { return catalog.find(function (p) { return p.id === row.querySelector('.product').value; }); }
  function rows() { return Array.from(items.querySelectorAll('.order-item')); }
  function usesCustomSize(product) { return product.sizeKind === 'cap' || (product.preorder && !product.stock); }
  function allowsMeasurements(product) { return Boolean(product.preorder && !product.stock && product.sizeKind === 'clothing'); }
  function sizeInputFor(row) { return row.querySelector(usesCustomSize(productFor(row)) ? '.custom-size' : '.size'); }
  function measurementsFor(row) {
    var group = row.querySelector('.preorder-measurements');
    if (group.disabled) return [];
    return Array.from(group.querySelectorAll('.measurement')).filter(function (input) {
      return Number.isFinite(parseMeasurement(input.value));
    }).map(function (input) {
      return input.dataset.measurement + ': ' + money.format(parseMeasurement(input.value)) + ' см';
    });
  }
  function clearErrors() {
    document.getElementById('orderError').hidden = true;
    items.querySelectorAll('[aria-invalid]').forEach(function (input) { input.removeAttribute('aria-invalid'); input.removeAttribute('aria-describedby'); });
    items.querySelectorAll('.field-error').forEach(function (error) { error.hidden = true; });
  }
  function showError(row, input, message) {
    var error = document.getElementById('orderError');
    error.textContent = 'Товар ' + (rows().indexOf(row) + 1) + ': ' + message + ' Введённые данные сохранены в форме.';
    error.hidden = false;
    var fieldError = row.querySelector('.field-error');
    fieldError.textContent = message; fieldError.hidden = false;
    input.setAttribute('aria-invalid', 'true');
    input.setAttribute('aria-describedby', fieldError.id);
    fieldError.scrollIntoView({block:'center', behavior:'auto'});
    input.focus({preventScroll:true});
  }
  function remember() {
    if (!ready) return;
    var draft = {version:1, updatedAt:Date.now(), items:rows().map(function (row) {
      return {product:productFor(row).id, size:sizeInputFor(row).value, quantity:row.querySelector('.quantity').value, help:row.querySelector('.help-size').checked, measurements:Array.from(row.querySelectorAll('.measurement')).map(function (input) { return input.value; })};
    })};
    try {
      root.sessionStorage.setItem(draftKey, JSON.stringify(draft));
      document.getElementById('draftStatus').textContent = 'Выбор и мерки сохранены в этой вкладке на 24 часа. Заявка ещё не отправлена.';
    } catch (_) {
      document.getElementById('draftStatus').textContent = 'Браузер запретил сохранение черновика. Не закрывайте и не обновляйте эту вкладку до отправки заявки.';
    }
  }
  function preorderTiming(product) { return product.preorderRelease ? 'плановая дата выпуска — ' + product.preorderRelease : product.preorderLeadTime ? 'срок — ' + product.preorderLeadTime : 'срок согласуем при подтверждении заказа'; }
  function stockTotal(product) { return Object.values(product.stock || {}).reduce(function (sum, value) { return sum + value; }, 0); }
  function quantityFor(row) {
    var value = row.querySelector('.quantity').valueAsNumber;
    return Number.isInteger(value) && value >= 1 && value <= 99 ? value : null;
  }
  function refresh() {
    var total = 0;
    var valid = true;
    var all = rows();
    var quantitiesByProduct = {};
    var quantitiesBySize = {};
    all.forEach(function (row) {
      var product = productFor(row);
      var quantity = quantityFor(row);
      if (!product.stock || quantity === null) return;
      quantitiesByProduct[product.id] = (quantitiesByProduct[product.id] || 0) + quantity;
      if (!row.querySelector('.help-size').checked && sizeInputFor(row).value) {
        var key = product.id + ':' + sizeInputFor(row).value;
        quantitiesBySize[key] = (quantitiesBySize[key] || 0) + quantity;
      }
    });
    all.forEach(function (row, index) {
      var product = productFor(row);
      var quantity = quantityFor(row);
      var quantityInput = row.querySelector('.quantity');
      var size = sizeInputFor(row).value;
      var helpSize = row.querySelector('.help-size').checked;
      quantityInput.setCustomValidity('');
      quantityInput.max = product.stock ? (!helpSize && size ? product.stock[size] || 0 : stockTotal(product)) : 99;
      if (product.stock && quantitiesByProduct[product.id] > stockTotal(product)) {
        quantityInput.setCustomValidity('Всего этой модели в наличии ' + stockTotal(product) + ' шт. Уменьшите количество в заказе.');
      } else if (product.stock && !helpSize && size && quantitiesBySize[product.id + ':' + size] > product.stock[size]) {
        quantityInput.setCustomValidity('Размер ' + size + ': в наличии ' + product.stock[size] + ' шт. с учётом всех строк заказа.');
      }
      if (!quantityInput.validity.valid) valid = false;
      row.querySelector('legend').textContent = 'Товар ' + (index + 1);
      row.querySelector('.remove').disabled = all.length === 1;
      row.querySelector('.remove').setAttribute('aria-label', 'Убрать товар ' + (index + 1));
      row.querySelector('.item-price').textContent = quantity === null ? 'Укажите количество' : rub(product.basePrice * quantity);
      if (quantity === null) valid = false;
      else total += product.basePrice * quantity;
    });
    document.getElementById('orderTotal').textContent = valid ? rub(total) : '—';
    addButton.disabled = all.length >= 10;
  }
  function setProduct(row) {
    clearErrors();
    var product = productFor(row);
    var photo = row.querySelector('.product-photo');
    photo.src = product.img;
    photo.alt = product.name;
    photo.style.backgroundColor = product.bg || '#0b1015';
    row.querySelector('.product-material').textContent = product.material || product.desc;
    row.querySelector('.stock-note').textContent = product.preorder
      ? (product.preorderRelease ? 'Доступен предзаказ. Плановая дата выпуска — ' + product.preorderRelease + '.' : product.preorderLeadTime ? 'Товар закончился. Возможен предзаказ. Срок — ' + product.preorderLeadTime + '.' : 'Доступен предзаказ. Размер и срок согласуем при подтверждении заказа.') + ' При предзаказе — предоплата 50% стоимости товара.'
      : 'В наличии: ' + Object.entries(product.stock || {}).filter(function (entry) { return entry[1] > 0; }).map(function (entry) { return entry[0] + ' — ' + entry[1] + ' шт.'; }).join(' · ');
    var isCap = product.sizeKind === 'cap';
    var customSize = usesCustomSize(product);
    row.querySelector('.size-label span').textContent = isCap ? 'Обхват головы, см' : customSize ? 'Ваш размер (или заполните мерки ниже)' : 'Размер в наличии';
    var sizeSelect = row.querySelector('.size');
    var customSizeInput = row.querySelector('.custom-size');
    sizeSelect.replaceChildren();
    var placeholder = document.createElement('option');
    placeholder.value = ''; placeholder.textContent = 'Выберите размер';
    sizeSelect.appendChild(placeholder);
    Object.entries(product.stock || {}).forEach(function (entry) {
      if (entry[1] <= 0) return;
      var option = document.createElement('option');
      option.value = entry[0]; option.textContent = entry[0] + ' — ' + entry[1] + ' шт. в наличии';
      sizeSelect.appendChild(option);
    });
    sizeSelect.hidden = customSize; sizeSelect.disabled = customSize; sizeSelect.required = !customSize;
    customSizeInput.hidden = !customSize; customSizeInput.disabled = !customSize; customSizeInput.required = customSize && !allowsMeasurements(product);
    customSizeInput.placeholder = isCap ? 'Например, 58' : 'Например, M'; customSizeInput.value = '';
    row.querySelector('.size-label').htmlFor = (customSize ? customSizeInput : sizeSelect).id;
    sizeSelect.setCustomValidity(''); customSizeInput.setCustomValidity('');
    row.querySelector('.help-size').checked = false;
    var measurements = row.querySelector('.preorder-measurements');
    var showMeasurements = Boolean(product.preorder && product.sizeKind === 'clothing');
    measurements.hidden = !showMeasurements;
    measurements.disabled = !showMeasurements;
    measurements.querySelectorAll('.measurement').forEach(function (input) { input.value = ''; });
    refresh();
  }
  function addItem(productId, focus) {
    if (rows().length >= 10) return;
    var row = template.content.firstElementChild.cloneNode(true);
    nextItemId += 1;
    row.querySelector('.size').id = 'size-' + nextItemId;
    row.querySelector('.custom-size').id = 'custom-size-' + nextItemId;
    row.querySelector('.field-error').id = 'item-error-' + nextItemId;
    var select = row.querySelector('.product');
    catalog.forEach(function (p) {
      var option = document.createElement('option');
      option.value = p.id;
      option.textContent = p.name + ' · ' + p.price + (p.preorder ? ' · предзаказ, предоплата 50%, ' + preorderTiming(p) : '');
      select.appendChild(option);
    });
    if (catalog.some(function (p) { return p.id === productId; })) select.value = productId;
    items.appendChild(row);
    select.addEventListener('change', function () { setProduct(row); });
    row.querySelector('.quantity').addEventListener('input', refresh);
    row.querySelector('.size').addEventListener('change', function () { this.setCustomValidity(''); refresh(); });
    row.querySelector('.custom-size').addEventListener('input', function () { this.setCustomValidity(''); });
    row.querySelector('.help-size').addEventListener('change', function () {
      var size = sizeInputFor(row);
      size.disabled = this.checked;
      size.required = !this.checked && !allowsMeasurements(productFor(row));
      size.setCustomValidity('');
      refresh();
    });
    row.querySelector('.remove').addEventListener('click', function () {
      if (rows().length <= 1) return;
      row.remove(); clearErrors(); refresh(); remember(); addButton.focus();
    });
    setProduct(row);
    if (focus) select.focus();
    return row;
  }
  addButton.addEventListener('click', function () { addItem(catalog[0].id, true); remember(); });
  builder.addEventListener('input', function () { clearErrors(); remember(); });
  builder.addEventListener('change', function () { clearErrors(); remember(); });
  builder.addEventListener('submit', function (event) {
    event.preventDefault();
    var error = document.getElementById('orderError');
    clearErrors();
    remember();
    refresh();
    var order = [];
    for (var row of rows()) {
      var product = productFor(row);
      var quantity = quantityFor(row);
      var quantityInput = row.querySelector('.quantity');
      if (quantity === null || !quantityInput.validity.valid) {
        showError(row, quantityInput, quantityInput.validity.customError ? quantityInput.validationMessage : 'Укажите целое количество от 1 до ' + quantityInput.max + '.'); return;
      }
      var measurementInputs = row.querySelector('.preorder-measurements').disabled ? [] : Array.from(row.querySelectorAll('.measurement'));
      var measurementValues = measurementInputs.map(function (input) { return parseMeasurement(input.value); });
      var badMeasurement = measurementValues.findIndex(Number.isNaN);
      if (badMeasurement !== -1) {
        showError(row, measurementInputs[badMeasurement], 'Проверьте ' + measurementInputs[badMeasurement].dataset.measurement + ': число от 1 до 300 см, например 100 или 100,5.'); return;
      }
      var sizeInput = sizeInputFor(row);
      var helpSize = row.querySelector('.help-size').checked;
      var size = resolveSize(product, sizeInput.value, helpSize, measurementValues);
      if (!size) { showError(row, sizeInput, measurementInputs.length ? 'Укажите размер, заполните хотя бы одну мерку или отметьте «Нужна помощь с размером».' : 'Укажите размер или отметьте «Нужна помощь с размером».'); return; }
      order.push({product:product, quantity:quantity, size:size, measurements:measurementsFor(row)});
    }
    if (!order.length) return;
    var total = order.reduce(function (sum, line) { return sum + line.product.basePrice * line.quantity; }, 0);
    var lines = order.map(function (line, index) {
      var sizeLabel = line.product.sizeKind === 'cap' ? 'обхват головы' : 'размер';
      return (index + 1) + '. ' + line.product.name + ' — ' + sizeLabel + ': ' + line.size + (line.measurements.length ? '; мерки — ' + line.measurements.join(', ') : '') + '; ' + line.quantity + ' шт. × ' + rub(line.product.basePrice) + ' = ' + rub(line.product.basePrice * line.quantity) + (line.product.preorder ? '; ПРЕДЗАКАЗ, ' + preorderTiming(line.product) + '; предоплата 50% стоимости товара после подтверждения заказа' : '; наличие подтвердим при обработке заявки');
    });
    var message = ['ЗАКАЗ ЭКИПИРОВКИ ВАРГИ', '', lines.join('\n'), '', 'Стоимость товаров: ' + rub(total) + '.', 'Цены фиксированные. Доставка не включена и рассчитывается отдельно. Наличие, доставка и оплата — после согласования.', '', 'Комментарий к заказу (если нужен):'].join('\n');
    if (message.length > 6000) { error.textContent = 'Сократите описание размеров и повторите оформление.'; error.hidden = false; return; }
    if (lastMessage && message !== lastMessage && !window.confirm('Состав заказа изменился. Контакты в форме потребуется заполнить заново. Обновить заказ?')) return;
    var summary = document.getElementById('summaryItems'); summary.replaceChildren();
    lines.forEach(function (line) { var li = document.createElement('li'); li.textContent = line; summary.appendChild(li); });
    document.getElementById('summaryTotal').textContent = 'Товары: ' + rub(total);
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
    document.getElementById('checkoutHeading').focus({preventScroll:true});
    checkout.scrollIntoView({block:'start', behavior:'auto'});
  });
  document.getElementById('editOrder').addEventListener('click', function () {
    checkout.hidden = true; builder.hidden = false;
    items.querySelector('.product').focus();
  });
  function initialItem() {
    var row = addItem(initialParams.get('product'), false);
    var initialSize = initialParams.get('size');
    var input = sizeInputFor(row);
    if (initialSize && (usesCustomSize(productFor(row)) || Array.from(input.options).some(function (option) { return option.value === initialSize; }))) input.value = initialSize.slice(0,40);
  }
  var saved = null;
  try { saved = readDraft(root.sessionStorage.getItem(draftKey), catalog, Date.now()); } catch (_) {}
  if (saved) {
    saved.forEach(function (line) {
      var row = addItem(line.product, false);
      var size = sizeInputFor(row);
      size.value = line.size;
      row.querySelector('.quantity').value = line.quantity;
      row.querySelector('.help-size').checked = line.help;
      size.disabled = line.help; size.required = !line.help && !allowsMeasurements(productFor(row));
      row.querySelectorAll('.measurement').forEach(function (input, index) { input.value = line.measurements[index]; });
    });
    document.getElementById('draftStatus').textContent = 'Выбор и мерки восстановлены в этой вкладке. Проверьте их перед оформлением. Заявка ещё не отправлена.';
  } else initialItem();
  document.getElementById('resetOrder').addEventListener('click', function () {
    if (!root.confirm('Очистить выбранные товары, размеры и мерки и начать заново?')) return;
    ready = false; items.replaceChildren(); initialItem(); refresh(); ready = true; remember();
    document.getElementById('draftStatus').textContent = 'Выбор очищен. Можно собрать новый заказ.';
  });
  ready = true;
  refresh();
  root.addEventListener('pagehide', remember);
  builder.hidden = false;
})(typeof window === 'undefined' ? globalThis : window);
