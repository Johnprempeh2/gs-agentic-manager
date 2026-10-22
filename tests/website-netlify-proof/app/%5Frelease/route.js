import { currentStrong } from '../proof-store.js';
export const dynamic = 'force-dynamic';
export async function GET() {
  const release = await currentStrong();
  return Response.json({ release, read: 'strong', at: new Date().toISOString() }, { headers: { 'Cache-Control': 'no-store' } });
}
