(() => {
  'use strict';
  const dialog = document.getElementById('nutrition-poster-dialog');
  if (!dialog || typeof dialog.showModal !== 'function') return;
  const poster = dialog.querySelector('.nutrition-poster-image');
  const title = dialog.querySelector('#nutrition-poster-title');
  let trigger = null;

  document.querySelectorAll('[data-nutrition-poster]').forEach(link => {
    link.addEventListener('click', event => {
      if (event.button !== 0 || event.ctrlKey || event.metaKey || event.shiftKey || event.altKey) return;
      event.preventDefault();
      trigger = link;
      title.textContent = link.dataset.posterTitle;
      poster.alt = `Прайс: ${link.dataset.posterTitle}`;
      poster.src = link.href;
      dialog.showModal();
      dialog.scrollTop = 0;
      document.body.classList.add('nutrition-modal-open');
    });
  });
  dialog.querySelector('.nutrition-poster-close').addEventListener('click', () => dialog.close());
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
