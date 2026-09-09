import cron, { ScheduledTask } from "node-cron";
import { DB_BACKUP_CONSTANTS } from "@/lib/constants";
import { runDatabaseBackup, DatabaseBackupResult, RunBackupOptions } from "@/lib/backup/dbBackup";

let backupScheduledTask: ScheduledTask | null = null;
let currentCronExpression: string | null = null;
let lastBackupResult: DatabaseBackupResult | null = null;
let lastBackupRunAt: Date | null = null;
let isBackupRunning = false;

/**
 * Starts the database backup cron job.
 * Reads cron expression from DB_BACKUP_CRON or defaults to 0 2 * * * (daily at 2 AM).
 */
export function startDatabaseBackupScheduler(customCron?: string): boolean {
  const isEnabled = process.env.DB_BACKUP_ENABLED !== "false";
  if (!isEnabled) {
    console.log("[BackupScheduler] Database backup cron disabled via DB_BACKUP_ENABLED=false");
    return false;
  }

  const cronExpression =
    customCron || process.env.DB_BACKUP_CRON || DB_BACKUP_CONSTANTS.DEFAULT_CRON_EXPRESSION;

  if (!cron.validate(cronExpression)) {
    console.error(`[BackupScheduler] Invalid cron expression: "${cronExpression}"`);
    return false;
  }

  // If already running with the same expression, don't restart
  if (backupScheduledTask && currentCronExpression === cronExpression) {
    console.log(`[BackupScheduler] Already running with schedule: "${cronExpression}"`);
    return true;
  }

  // If running with a different schedule, stop previous first
  if (backupScheduledTask) {
    stopDatabaseBackupScheduler();
  }

  console.log(`[BackupScheduler] Starting database backup cron with schedule: "${cronExpression}"`);

  currentCronExpression = cronExpression;
  backupScheduledTask = cron.schedule(
    cronExpression,
    async () => {
      if (isBackupRunning) {
        console.warn("[BackupScheduler] A backup is already in progress, skipping scheduled run");
        return;
      }

      isBackupRunning = true;
      lastBackupRunAt = new Date();
      console.log(`[BackupScheduler] Triggered scheduled database backup at ${lastBackupRunAt.toISOString()}`);

      try {
        const result = await runDatabaseBackup();
        lastBackupResult = result;
        if (result.success) {
          console.log(`[BackupScheduler] Scheduled database backup completed successfully (${result.fileName})`);
        } else {
          console.error(`[BackupScheduler] Scheduled database backup completed with issues:`, result);
        }
      } catch (error) {
        console.error(`[BackupScheduler] Scheduled database backup threw an error:`, error);
      } finally {
        isBackupRunning = false;
      }
    },
    {
      timezone: process.env.TZ || "UTC",
    },
  );

  console.log("[BackupScheduler] Database backup cron scheduler started successfully");
  return true;
}

/**
 * Stops the database backup cron task.
 */
export function stopDatabaseBackupScheduler(): void {
  if (backupScheduledTask) {
    backupScheduledTask.stop();
    backupScheduledTask = null;
    currentCronExpression = null;
    console.log("[BackupScheduler] Database backup cron stopped");
  }
}

/**
 * Checks if the backup scheduler is currently active.
 */
export function isDatabaseBackupSchedulerRunning(): boolean {
  return backupScheduledTask !== null;
}

/**
 * Returns current status of the database backup scheduler.
 */
export function getDatabaseBackupSchedulerStatus() {
  return {
    isRunning: backupScheduledTask !== null,
    cronExpression: currentCronExpression,
    timezone: process.env.TZ || "UTC",
    isBackupInProgress: isBackupRunning,
    lastRunAt: lastBackupRunAt,
    lastResult: lastBackupResult,
  };
}

/**
 * Triggers an immediate backup run on-demand (used by API routes or manual triggers).
 */
export async function runDatabaseBackupNow(options: RunBackupOptions = {}): Promise<DatabaseBackupResult> {
  if (isBackupRunning) {
    throw new Error("A database backup is already currently in progress.");
  }

  isBackupRunning = true;
  lastBackupRunAt = new Date();

  try {
    const result = await runDatabaseBackup(options);
    lastBackupResult = result;
    return result;
  } finally {
    isBackupRunning = false;
  }
}
