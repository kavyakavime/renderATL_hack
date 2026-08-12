import 'dotenv/config';
import { loadDestinationIndex, resolveDestination } from '../web/destinations.js';
const index = await loadDestinationIndex();
for (const q of ['Georgia Tech', 'gt', 'Tech Square', 'airport', 'Ponce City Market']) {
  const dest = resolveDestination(index, { destination: q });
  if ('error' in dest) { console.log(q, '-> ERROR:', dest.error); continue; }
  console.log(`${q} -> stop "${dest.stop.name}" · ${dest.nearby_stops.length} nearby · routes: ${dest.candidate_routes.join(', ')}`);
}
