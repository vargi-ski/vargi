(function () {
  'use strict';

  // Six prepared photos fit with room for form fields and multipart overhead.
  // VargiConnection separately enforces the exact serialized 2,000,000-byte cap.
  const GATEWAY_PHOTO_BYTES = 300000;
  const GATEWAY_PHOTOS_BYTES = 1850000;
  const LEGACY_PHOTOS_BYTES = 24 * 1024 * 1024;

  function fail(message, code = 'PHOTO') {
    return Object.assign(new Error(message), { code });
  }

  async function signature(file) {
    const b = new Uint8Array(await file.slice(0, 12).arrayBuffer());
    const text = (start, end) => String.fromCharCode(...b.slice(start, end));
    const brand = text(8, 12).toLowerCase();
    return b[0] === 255 && b[1] === 216 && b[2] === 255 ? 'image/jpeg'
      : b[0] === 137 && b[1] === 80 && b[2] === 78 && b[3] === 71 ? 'image/png'
      : text(0, 4) === 'RIFF' && text(8, 12) === 'WEBP' ? 'image/webp'
      : text(4, 8) === 'ftyp' && ['heic', 'heix', 'hevc', 'hevx', 'mif1', 'msf1'].includes(brand) ? 'image/heic' : '';
  }

  function copiedFile(file, mime) {
    return new File([file], file.name || (mime === 'image/heic' ? 'photo.heic' : 'photo'), {
      type: mime, lastModified: file.lastModified
    });
  }

  async function decode(img) {
    let timer;
    try {
      await Promise.race([img.decode(), new Promise((_, reject) => {
        timer = setTimeout(() => reject(fail('Не удалось прочитать фото вовремя. Выберите другой файл.')), 15000);
      })]);
    } finally { clearTimeout(timer); }
  }

  async function preparePhoto(file, { gateway = false } = {}) {
    const mime = await signature(file);
    if (!mime) throw fail('Нужен настоящий JPEG, PNG, WebP или HEIC.');
    const declared = ({ 'image/jpg': 'image/jpeg', 'image/pjpeg': 'image/jpeg', 'image/x-png': 'image/png',
      'image/heif': 'image/heic', 'application/octet-stream': '' })[file.type] ?? file.type;
    if (declared && declared !== mime) throw fail('Тип файла не соответствует его содержимому. Сохраните снимок как JPEG и выберите его заново.');
    if (!file.size || file.size > 15 * 1024 * 1024) throw fail('Исходный файл должен быть не больше 15 МБ.');
    if (mime === 'image/heic') {
      if (file.size > 8 * 1024 * 1024) throw fail('HEIC-файл должен быть не больше 8 МБ.');
      if (!gateway) return copiedFile(file, mime);
    }

    const src = URL.createObjectURL(file);
    const canvas = document.createElement('canvas');
    try {
      const img = new Image();
      img.src = src;
      try { await (gateway ? decode(img) : img.decode()); }
      catch (_) {
        // A native HEIC decoder is available in some browsers, including Safari.
        // Otherwise a small original can still reach the existing server decoder.
        if (gateway && mime === 'image/heic' && file.size <= GATEWAY_PHOTOS_BYTES) return copiedFile(file, mime);
        if (gateway && mime === 'image/heic') throw fail('Этот браузер не смог уменьшить HEIC до размера заявки. Сохраните фото как JPEG и выберите его заново. Исходный файл не изменён.', 'HEIC_LIMIT');
        throw fail('Не удалось прочитать фото. Сохраните снимок как JPEG или выберите другой файл.');
      }
      if (!img.naturalWidth || !img.naturalHeight) throw fail('Не удалось определить размер фото. Выберите другой файл.');
      if (img.naturalWidth * img.naturalHeight > 64000000) throw fail('Фото больше 64 мегапикселей. Уменьшите разрешение снимка и выберите его заново.');
      const initialScale = Math.min(1, 1800 / Math.max(img.naturalWidth, img.naturalHeight));
      const passthroughBytes = gateway ? GATEWAY_PHOTO_BYTES : 1400 * 1024;
      if (mime !== 'image/heic' && initialScale === 1 && file.size <= passthroughBytes) return copiedFile(file, mime);

      const maxBytes = gateway ? GATEWAY_PHOTO_BYTES : 2300 * 1024;
      const sides = gateway ? [1800, 1500, 1200, 1000, 800] : [1800];
      let result = null;
      for (const maxSide of sides) {
        const scale = Math.min(1, maxSide / Math.max(img.naturalWidth, img.naturalHeight));
        canvas.width = Math.max(1, Math.round(img.naturalWidth * scale));
        canvas.height = Math.max(1, Math.round(img.naturalHeight * scale));
        const ctx = canvas.getContext('2d', { alpha: false });
        if (!ctx) throw fail('Браузер не смог подготовить фотографию. Выберите другой файл.');
        if (gateway) {
          ctx.fillStyle = '#fff';
          ctx.fillRect(0, 0, canvas.width, canvas.height);
        }
        ctx.drawImage(img, 0, 0, canvas.width, canvas.height);
        for (const quality of [.82, .72, .62, .52]) {
          result = await new Promise(resolve => canvas.toBlob(resolve, 'image/jpeg', quality));
          if (result && result.type === 'image/jpeg' && result.size <= maxBytes) break;
        }
        if (result && result.type === 'image/jpeg' && result.size <= maxBytes) break;
      }
      if (!result || result.type !== 'image/jpeg' || result.size > maxBytes) throw fail('Фото не удалось уменьшить до допустимого размера. Выберите другое изображение.');
      const base = (file.name.replace(/\.[^.]+$/, '') || 'photo').replace(/[^a-zA-Z0-9а-яА-ЯёЁ_-]+/g, '-').slice(0, 60);
      return new File([result], base + '.jpg', { type: 'image/jpeg', lastModified: Date.now() });
    } finally {
      URL.revokeObjectURL(src);
      canvas.width = canvas.height = 1;
    }
  }

  window.VargiPhotos = {
    signature, preparePhoto,
    totalPhotoBytes(gateway = false) { return gateway ? GATEWAY_PHOTOS_BYTES : LEGACY_PHOTOS_BYTES; }
  };
})();
