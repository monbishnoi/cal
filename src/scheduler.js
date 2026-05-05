/**
 * Scheduler for Cal Gateway
 *
 * Manages cron jobs that trigger autonomous Claude executions.
 * Uses node-cron for scheduling.
 */

import cron from 'node-cron';
import { isFeatureEnabled, getFeatureConfig } from './features.js';
import { logError } from './logger.js';
import { expandPathPlaceholders } from './paths.js';
import { getTimezone, getLocale, expandUserPlaceholders } from './user-config.js';
import { loadGatewayConfig } from './runtime-config.js';

// Store active cron jobs
const activeJobs = new Map();

/**
 * Load job configuration
 * Expands {{CAL_HOME}} and {{USER_NAME}} placeholders in prompts for portability
 */
export function loadJobs() {
  try {
    const config = structuredClone(loadGatewayConfig());

    // Expand path and user placeholders in job prompts
    for (const job of config.jobs) {
      if (job.prompt) {
        job.prompt = expandPathPlaceholders(job.prompt);
        job.prompt = expandUserPlaceholders(job.prompt);
      }
    }

    return config;
  } catch (err) {
    console.error('[Scheduler] Failed to load jobs config:', err.message);
    return { jobs: [], settings: {} };
  }
}

/**
 * Initialize scheduler with jobs from config
 *
 * @param {Function} executor - Function to execute when job fires: (job) => Promise<string>
 */
export function initScheduler(executor) {
  const config = loadJobs();

  console.log(`[Scheduler] Loading ${config.jobs.length} jobs...`);

  // Get QMD feature config to check which jobs are QMD-related
  const qmdConfig = getFeatureConfig('qmd');
  const qmdJobIds = qmdConfig?.cronJobs ? Object.values(qmdConfig.cronJobs) : [];

  for (const job of config.jobs) {
    if (!job.enabled) {
      console.log(`[Scheduler] Skipping disabled job: ${job.id}`);
      continue;
    }

    // Skip QMD-related jobs if QMD feature is disabled
    if (qmdJobIds.includes(job.id) && !isFeatureEnabled('qmd')) {
      console.log(`[Scheduler] Skipping QMD job (feature disabled): ${job.id}`);
      continue;
    }

    // Skip jobs with featureFlag if that feature is disabled
    if (job.featureFlag && !isFeatureEnabled(job.featureFlag)) {
      console.log(`[Scheduler] Skipping job (feature '${job.featureFlag}' disabled): ${job.id}`);
      continue;
    }

    // Validate cron expression
    if (!cron.validate(job.cron)) {
      console.error(`[Scheduler] Invalid cron expression for ${job.id}: ${job.cron}`);
      continue;
    }

    // Schedule the job
    const cronJob = cron.schedule(job.cron, async () => {
      console.log(`\n[Scheduler] === JOB FIRED: ${job.id} ===`);
      console.log(`[Scheduler] Time: ${new Date().toLocaleString(getLocale(), { timeZone: getTimezone() })}`);

      try {
        await executor(job);
        console.log(`[Scheduler] === JOB COMPLETE: ${job.id} ===\n`);
      } catch (err) {
        console.error(`[Scheduler] Job failed (${job.id}):`, err.message);

        // Log job failure with structured data
        logError('job_failed', {
          session: 'scheduler',
          job: job.id,
          error: err.message,
        });
      }
    }, {
      timezone: config.settings?.timezone || getTimezone(),
    });

    activeJobs.set(job.id, cronJob);
    console.log(`[Scheduler] Scheduled: ${job.id} (${job.cron})`);
  }

  console.log(`[Scheduler] ${activeJobs.size} jobs active`);

  return activeJobs;
}

/**
 * Manually trigger a job by ID (for testing)
 */
export async function triggerJob(jobId, executor) {
  const config = loadJobs();
  const job = config.jobs.find(j => j.id === jobId);

  if (!job) {
    throw new Error(`Job not found: ${jobId}`);
  }

  console.log(`[Scheduler] Manually triggering: ${jobId}`);
  return await executor(job);
}

/**
 * Stop all scheduled jobs
 */
export function stopScheduler() {
  console.log('[Scheduler] Stopping all jobs...');

  for (const [id, job] of activeJobs) {
    job.stop();
    console.log(`[Scheduler] Stopped: ${id}`);
  }

  activeJobs.clear();
}

/**
 * Get status of all jobs
 */
export function getJobStatus() {
  const config = loadJobs();

  return config.jobs.map(job => ({
    id: job.id,
    name: job.name,
    cron: job.cron,
    enabled: job.enabled,
    active: activeJobs.has(job.id),
  }));
}
