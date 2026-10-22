import { getStore } from '@netlify/blobs';
import { readFileSync } from 'node:fs';
const [, , siteID, tokenFile, value] = process.argv;
if (!siteID || !tokenFile || !value) throw Error('Usage: node writer.mjs SITE_ID TOKEN_FILE RELEASE');
const token = readFileSync(tokenFile, 'utf8').trim();
const store = getStore('gre-1915-proof', { siteID, token });
await store.set(`releases/${value}.json`, JSON.stringify({ release: value }));
await store.set('current', value);
console.log(JSON.stringify({written: value, strongRead: await store.get('current', {consistency:'strong'}), at: new Date().toISOString()}));
