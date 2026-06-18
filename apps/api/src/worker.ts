import 'reflect-metadata';
import { Queue, Worker } from 'bullmq';
import { Redis } from 'ioredis';

/**
 * Background worker entrypoint (runs as its own container).
 *
 * For now it runs a heartbeat to prove the queue is alive. Real scheduled jobs
 * land here in later increments: legacy import/sync, overnight QuickBooks
 * reconciliation, automatic sublot expiry, MRP/plan-trace recalculation, and
 * email notifications.
 */

const connection = new Redis(process.env.REDIS_URL ?? 'redis://redis:6379', {
  maxRetriesPerRequest: null,
});

const SYSTEM_QUEUE = 'system';

async function main(): Promise<void> {
  const queue = new Queue(SYSTEM_QUEUE, { connection });

  // Repeatable heartbeat (placeholder schedule).
  await queue.add(
    'heartbeat',
    {},
    {
      repeat: { every: 5 * 60 * 1000 },
      removeOnComplete: true,
      removeOnFail: 100,
      jobId: 'heartbeat', // dedupe the repeatable
    },
  );

  const worker = new Worker(
    SYSTEM_QUEUE,
    async (job) => {
      switch (job.name) {
        case 'heartbeat':
          return { ok: true, at: new Date().toISOString() };
        default:
          return {};
      }
    },
    { connection },
  );

  worker.on('ready', () => console.log('[worker] ready'));
  worker.on('failed', (job, err) => console.error('[worker] job failed:', job?.name, err?.message));

  console.log('[worker] started');
}

main().catch((err) => {
  console.error('[worker] fatal:', err);
  process.exit(1);
});
