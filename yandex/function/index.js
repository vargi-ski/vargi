// CommonJS entrypoint configured as index.handler in Yandex Cloud Functions.
exports.handler = async (event, context) => (await import('./submit.mjs')).handler(event, context);
