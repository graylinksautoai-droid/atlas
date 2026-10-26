import { closePool } from '../src/db.ts';
import { seed } from './seed.ts';

/** Controlled demo reset: truncates every domain table and reseeds relative dates. */
async function reset(): Promise<void> {
  const summary = await seed();
  console.log(`reset complete: ${summary.projects} projects, ${summary.obligations} obligations, ${summary.documents} documents`);
}

if (import.meta.url === `file://${process.argv[1]}`) {
  reset()
    .catch((error) => {
      console.error(error);
      process.exitCode = 1;
    })
    .finally(() => closePool());
}
