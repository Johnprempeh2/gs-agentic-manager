import { currentCached } from '../../proof-store.js';
import { redirect } from 'next/navigation';
export const revalidate = 3600;
export const dynamicParams = true;
export async function generateStaticParams() { return []; }
export default async function CheckPage({ params }) {
  const { slug } = await params;
  if (slug === 'old') redirect('/check/home');
  if (!['home','inner','product'].includes(slug)) return <p>Unknown check page</p>;
  const release = await currentCached();
  return <html><body><main><h1>{slug}</h1><p id="release">{release}</p></main></body></html>;
}
