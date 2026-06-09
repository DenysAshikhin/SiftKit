import { WebFetchService } from './src/web-search/web-fetch-service.ts';
const cfg = { TimeoutMs: 30000, FetchMaxCharacters: 20000 };
const svc = new WebFetchService(cfg);
for (const url of ['https://en.wikipedia.org/wiki/RuneScape','https://www.runescape.com','http://en.wikipedia.org/wiki/RuneScape']) {
  try { const r = await svc.fetch({ url }); console.log('OK', url, '=> finalUrl', r.finalUrl, 'titleLen', r.title.length, 'textLen', r.text.length); }
  catch (e) { console.log('THROW', url, '=>', e.message); }
}
