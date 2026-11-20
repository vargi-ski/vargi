(() => {
  const controls = Array.from(document.querySelectorAll('.site-shortcuts,.pack-join-fab'));
  if (!controls.length) return;
  const update = () => {
    const editable = document.activeElement?.matches('input,textarea,select,[contenteditable="true"]');
    const viewport = window.visualViewport;
    const hidden = Boolean(editable && viewport && viewport.height < innerHeight * 0.8);
    controls.forEach(control => { control.hidden = hidden; });
  };
  window.visualViewport?.addEventListener('resize', update);
  document.addEventListener('focusin', update);
  document.addEventListener('focusout', update);
  update();
})();

