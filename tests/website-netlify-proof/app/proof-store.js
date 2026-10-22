import { getStore } from '@netlify/blobs';
import { unstable_cache } from 'next/cache';
const store = () => getStore('gre-1915-proof');
export async function currentStrong() {
  const value = await store().get('current', { consistency: 'strong' });
  return value || 'missing';
}
export const currentCached = unstable_cache(currentStrong, ['gre-1915-current'], { tags: ['gre-1915-content'], revalidate: 3600 });
