(function () {
  'use strict';
  let database;
  function open() {
    if (!database) database = new Promise((resolve, reject) => {
      const request = indexedDB.open('vargi-board-draft', 1);
      let expired=false;
      const timer=setTimeout(()=>{expired=true;reject(new Error('Хранилище не ответило'))},3000);
      request.onupgradeneeded = () => request.result.createObjectStore('drafts');
      request.onsuccess = () => {clearTimeout(timer);if(expired)request.result.close();else resolve(request.result)};
      request.onerror = () => {clearTimeout(timer);reject(request.error)};
      request.onblocked = () => {clearTimeout(timer);expired=true;reject(new Error('Хранилище занято другой вкладкой'))};
    });
    return database;
  }
  async function operation(mode, action) {
    const db = await open();
    return new Promise((resolve, reject) => {
      const tx = db.transaction('drafts', mode);
      const request = action(tx.objectStore('drafts'));
      const timer=setTimeout(()=>{try{tx.abort()}catch(_){}reject(new Error('Сохранение не завершилось'))},5000);
      tx.oncomplete = () => {clearTimeout(timer);resolve(request.result)};
      tx.onerror = tx.onabort = () => {clearTimeout(timer);reject(tx.error || request.error)};
    });
  }
  // Serialize writes and clearing so a late autosave cannot resurrect a sent draft.
  let pending = Promise.resolve();
  function write(action) {
    const next = pending.catch(() => {}).then(() => operation('readwrite', action));
    pending = next;
    return next;
  }
  window.VargiDraft = {
    async load() {
      const draft = await operation('readonly', store => store.get('current'));
      if (draft && (draft.version !== 1 || Date.now() - draft.savedAt > 7 * 86400000)) {
        await this.clear();
        return null;
      }
      return draft || null;
    },
    save(draft) { return write(store => store.put({ ...draft, version: 1, savedAt: Date.now() }, 'current')); },
    clear() { return write(store => store.delete('current')); }
  };
})();
