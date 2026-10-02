(function () {
  'use strict';
  const catalog = window.VARGI_SHOP || [];
  const categories = window.VARGI_SHOP_CATEGORIES || [];
  const $ = id => document.getElementById(id);
  const escape = value => String(value).replace(/[&<>"']/g, ch => ({'&':'&amp;','<':'&lt;','>':'&gt;','"':'&quot;',"'":'&#39;'}[ch]));
  const dialog = $('productDialog');
  const activeProducts = catalog.filter(p => !p.soon);
  const upcoming = catalog.filter(p => p.soon);
  let shownProduct = null;

  function productUrl(id) {
    const url = new URL(window.location.href);
    url.searchParams.set('product', id);
    return url.pathname + url.search;
  }
  function orderUrl(product, size) {
    const url = new URL('/shop/order/', window.location.origin);
    url.searchParams.set('product', product.id);
    if (size) url.searchParams.set('size', size);
    return url.pathname + url.search;
  }
  function categoryUrl(id) { return '/shop/' + (id ? '?category=' + encodeURIComponent(id) : ''); }
  function inStock(product) {
    return Boolean(product.available && (!product.stock || Object.values(product.stock).some(quantity => quantity > 0)));
  }
  function availability(product) {
    if (product.preorderRelease) return 'Доступен предзаказ';
    if (!inStock(product)) return product.preorder ? 'Товар закончился · доступен предзаказ' : 'Товар закончился';
    return 'В наличии';
  }
  function timing(product) {
    if (!product.preorder) return '';
    return product.preorderRelease ? 'Плановый выпуск — ' + product.preorderRelease + '.' : product.preorderLeadTime ? 'Срок предзаказа — ' + product.preorderLeadTime + '.' : '';
  }
  function productCard(product) {
    const sizes = Object.entries(product.stock || {}).filter(([, quantity]) => quantity > 0);
    const soldOutSizes = Object.entries(product.stock || {}).filter(([, quantity]) => quantity === 0);
    return '<a class="product-card" data-product="' + escape(product.id) + '" href="' + escape(productUrl(product.id)) + '">' +
      '<div class="card-photo"><img src="' + escape(product.img) + '" alt="' + escape(product.name) + '" loading="lazy" decoding="async"></div>' +
      '<div class="card-info"><p class="availability' + (!inStock(product) && !product.preorderRelease ? ' availability--sold-out' : '') + '">' + escape(availability(product)) + '</p>' +
      '<h3>' + escape(product.name) + '</h3>' +
      '<div class="card-description">' + product.desc + '</div>' +
      (product.material ? '<p class="card-material">Состав: ' + escape(product.material) + '</p>' : '') +
      '<div class="card-stock">' +
      (inStock(product) && sizes.length ? '<p>Размеры в наличии:</p><div class="card-sizes">' + sizes.map(([size, quantity]) => '<span>' + escape(size) + ' · ' + quantity + ' шт.</span>').join('') + '</div>' : '') +
      (soldOutSizes.length ? '<p class="card-sold-out-sizes">Закончились: ' + soldOutSizes.map(([size]) => escape(size)).join(', ') + '.</p>' : '') +
      (timing(product) ? '<p class="card-timing">' + escape(timing(product)) + '</p>' : '') +
      '</div><div class="card-foot"><span class="card-price">' + escape(product.price) + '</span><span class="card-more">Подробнее ↗</span></div></div></a>';
  }
  function openProduct(product) {
    if (shownProduct === product.id && dialog.open) return;
    shownProduct = product.id;
    $('detailCategory').textContent = categories.find(c => c.id === product.category)?.title || 'Экипировка стаи';
    $('detailTitle').textContent = product.name;
    $('detailPhoto').src = product.img;
    $('detailPhoto').alt = product.name;
    $('detailPhotoLink').href = product.img;
    $('detailPhotoLink').setAttribute('aria-label', 'Увеличить фото: ' + product.name);
    $('detailAvailability').textContent = availability(product);
    $('detailDescription').innerHTML = product.desc;
    $('detailMaterial').textContent = product.material ? 'Состав: ' + product.material : '';
    $('detailMaterial').hidden = !product.material;
    $('detailTiming').textContent = timing(product);
    $('detailTiming').hidden = !timing(product);
    const sizes = Object.entries(product.stock || {}).filter(([, quantity]) => quantity > 0);
    $('detailStock').hidden = !inStock(product) || sizes.length === 0;
    $('detailStock').innerHTML = sizes.length ? '<p>Размеры в наличии — нажмите, чтобы заказать:</p><div class="sizes">' + sizes.map(([size, quantity]) => '<a href="' + escape(orderUrl(product, size)) + '" aria-label="Заказать размер ' + escape(size) + '">' + escape(size) + ' · ' + quantity + ' шт.</a>').join('') + '</div>' : '';
    $('detailPrice').textContent = product.price;
    $('detailOrder').href = orderUrl(product);
    $('detailOrder').textContent = product.preorder ? 'Оформить предзаказ' : 'Заказать';
    $('detailOrder').hidden = !inStock(product) && !product.preorder;
    dialog.querySelector('.purchase-note').hidden = !inStock(product) && !product.preorder;
    document.body.classList.add('product-open');
    if (!dialog.open) dialog.showModal();
    dialog.scrollTop = 0;
  }
  function syncFromUrl() {
    const params = new URLSearchParams(window.location.search);
    const category = categories.find(c => c.id === params.get('category'));
    const categoryId = category?.id || '';
    $('shopFilters').innerHTML = [{id:'', title:'Всё'}, ...categories].map(c => '<a class="filter" href="' + categoryUrl(c.id) + '" aria-current="' + (c.id === categoryId) + '">' + escape(c.title) + '</a>').join('');
    const products = activeProducts.filter(p => !categoryId || p.category === categoryId);
    $('catalogTitle').textContent = category?.title || 'Вся экипировка';
    $('productCount').textContent = products.length + ' ' + (products.length === 1 ? 'модель' : products.length < 5 ? 'модели' : 'моделей');
    $('productGrid').innerHTML = products.map(productCard).join('');
    $('upcoming').hidden = Boolean(categoryId) || !upcoming.length;
    const product = activeProducts.find(p => p.id === params.get('product'));
    if (product) openProduct(product);
    else {
      const previousProduct = shownProduct;
      shownProduct = null;
      if (dialog.open) dialog.close();
      document.body.classList.remove('product-open');
      if (previousProduct) document.querySelector('[data-product="' + previousProduct + '"]')?.focus({preventScroll:true});
    }
  }
  function closeProduct() {
    if (history.state?.vargiProduct) history.back();
    else {
      const url = new URL(window.location.href);
      url.searchParams.delete('product');
      history.replaceState(null, '', url.pathname + url.search);
      syncFromUrl();
    }
  }
  function simpleClick(event) { return !event.ctrlKey && !event.metaKey && !event.shiftKey && !event.altKey && event.button === 0; }
  $('productGrid').addEventListener('click', event => {
    const link = event.target.closest('[data-product]');
    if (!link || !simpleClick(event)) return;
    event.preventDefault();
    history.pushState({vargiProduct:true}, '', link.href);
    syncFromUrl();
  });
  $('shopFilters').addEventListener('click', event => {
    const link = event.target.closest('a');
    if (!link || !simpleClick(event)) return;
    event.preventDefault();
    history.pushState(null, '', link.href);
    syncFromUrl();
  });
  $('closeProduct').addEventListener('click', closeProduct);
  dialog.addEventListener('cancel', event => { event.preventDefault(); closeProduct(); });
  dialog.addEventListener('click', event => {
    const bounds = dialog.getBoundingClientRect();
    if (event.target === dialog && (event.clientX < bounds.left || event.clientX > bounds.right || event.clientY < bounds.top || event.clientY > bounds.bottom)) closeProduct();
  });
  window.addEventListener('popstate', syncFromUrl);
  $('upcomingCount').textContent = upcoming.length;
  $('upcomingGrid').innerHTML = upcoming.map(p => '<article class="upcoming-item"><h3>' + escape(p.name) + '</h3><p>' + escape(p.desc) + '</p></article>').join('');
  syncFromUrl();
})();
