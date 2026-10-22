import { getStore } from '@netlify/blobs';
export default async () => {
 const release = await getStore('gre-1915-proof').get('current', {consistency:'strong'});
 return Response.json({release, at:new Date().toISOString()}, {headers:{'Netlify-CDN-Cache-Control':'public, max-age=3600','Netlify-Cache-Tag':'gre-1915-content'}});
};
