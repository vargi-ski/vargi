(() => {
  'use strict';
  const dialog = document.getElementById('nutrition-poster-dialog');
  if (!dialog || typeof dialog.showModal !== 'function') return;
  const poster = dialog.querySelector('.nutrition-poster-image');
  const title = dialog.querySelector('#nutrition-poster-title');
  const closeButton = dialog.querySelector('.nutrition-poster-close');
  const originalLink = dialog.querySelector('.nutrition-document-original');
  let trigger = null;

  document.querySelectorAll('[data-nutrition-poster], [data-nutrition-document]').forEach(link => {
    link.addEventListener('click', event => {
      if (event.button !== 0 || event.ctrlKey || event.metaKey || event.shiftKey || event.altKey) return;
      event.preventDefault();
      trigger = link;
      const isDocument = link.hasAttribute('data-nutrition-document');
      const label = isDocument ? link.dataset.documentTitle : link.dataset.posterTitle;
      title.textContent = label;
      poster.alt = isDocument ? label : `Прайс: ${label}`;
      poster.src = link.href;
      dialog.classList.toggle('nutrition-document-view', isDocument);
      closeButton.setAttribute('aria-label', isDocument ? 'Закрыть документ' : 'Закрыть прайс');
      if (originalLink) { originalLink.href = link.href; originalLink.hidden = !isDocument; }
      dialog.showModal();
      dialog.scrollTop = 0;
      document.body.classList.add('nutrition-modal-open');
    });
  });
  closeButton.addEventListener('click', () => dialog.close());
  dialog.addEventListener('click', event => {
    if (event.target !== dialog) return;
    const bounds = dialog.getBoundingClientRect();
    if (event.clientX < bounds.left || event.clientX > bounds.right || event.clientY < bounds.top || event.clientY > bounds.bottom) dialog.close();
  });
  dialog.addEventListener('close', () => {
    document.body.classList.remove('nutrition-modal-open');
    if (trigger) trigger.focus({ preventScroll: true });
  });
})();
