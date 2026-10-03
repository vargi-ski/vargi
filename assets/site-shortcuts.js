(() => {
  const shortcuts = document.querySelector('.site-shortcuts');
  if (!shortcuts) return;
  const update = () => {
    const editable = document.activeElement?.matches('input,textarea,select,[contenteditable="true"]');
    const viewport = window.visualViewport;
    shortcuts.hidden = Boolean(editable && viewport && viewport.height < innerHeight * 0.8);
  };
  window.visualViewport?.addEventListener('resize', update);
  document.addEventListener('focusin', update);
  document.addEventListener('focusout', update);
  update();
})();
