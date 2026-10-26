import { config } from './config.ts';
import { runComplianceCheck, type CheckResult } from './compliance.ts';

export interface SchedulerHandle {
  stop: () => void;
  runNow: () => Promise<CheckResult | null>;
}

/**
 * In process scheduler. It is real scheduled execution, not a check that only
 * runs when somebody loads a page, but it only lives as long as the process.
 * The README documents that limitation and the external cron alternative.
 */
export function startScheduler(onResult: (result: CheckResult) => void): SchedulerHandle {
  if (!config.schedulerEnabled) {
    return { stop: () => undefined, runNow: async () => null };
  }

  let running = false;
  const tick = async (): Promise<CheckResult | null> => {
    if (running) return null;
    running = true;
    try {
      const result = await runComplianceCheck({ trigger: 'SCHEDULER' });
      onResult(result);
      return result;
    } catch (error) {
      console.error(JSON.stringify({ level: 'error', msg: 'scheduler sweep crashed', error: String(error) }));
      return null;
    } finally {
      running = false;
    }
  };

  const initial = setTimeout(() => void tick(), 10_000);
  const interval = setInterval(() => void tick(), config.complianceIntervalMs);
  initial.unref?.();
  interval.unref?.();

  return {
    stop: () => {
      clearTimeout(initial);
      clearInterval(interval);
    },
    runNow: tick,
  };
}
