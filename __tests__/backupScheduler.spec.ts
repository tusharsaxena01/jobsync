import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";

// Mock node-cron
const mockTask = {
  stop: vi.fn(),
};
let scheduledCallback: (() => Promise<void>) | null = null;

vi.mock("node-cron", () => ({
  default: {
    schedule: vi.fn((expr, cb) => {
      scheduledCallback = cb;
      return mockTask;
    }),
    validate: vi.fn((expr: string) => expr !== "invalid-cron"),
  },
}));

// Mock dbBackup
const mockRunDatabaseBackup = vi.fn().mockResolvedValue({
  success: true,
  fileName: "job_sync_db_mock.db",
  fileSizeBytes: 1024,
  dbSourcePath: "/path/to/dev.db",
  timestamp: new Date().toISOString(),
  email: { attempted: true, success: true },
  googleDrive: { attempted: true, success: true },
  durationMs: 150,
});

vi.mock("@/lib/backup/dbBackup", () => ({
  runDatabaseBackup: (...args: any[]) => mockRunDatabaseBackup(...args),
}));

import {
  startDatabaseBackupScheduler,
  stopDatabaseBackupScheduler,
  isDatabaseBackupSchedulerRunning,
  getDatabaseBackupSchedulerStatus,
  runDatabaseBackupNow,
} from "@/lib/scheduler/backupScheduler";
import cron from "node-cron";

describe("Database Backup Scheduler (backupScheduler)", () => {
  const originalEnv = { ...process.env };

  beforeEach(() => {
    vi.clearAllMocks();
    process.env = { ...originalEnv };
    stopDatabaseBackupScheduler();
  });

  afterEach(() => {
    process.env = originalEnv;
    stopDatabaseBackupScheduler();
  });

  it("starts the cron scheduler with the default or env-configured cron expression", () => {
    process.env.DB_BACKUP_CRON = "0 3 * * *";
    const started = startDatabaseBackupScheduler();

    expect(started).toBe(true);
    expect(isDatabaseBackupSchedulerRunning()).toBe(true);
    expect(cron.schedule).toHaveBeenCalledWith("0 3 * * *", expect.any(Function), expect.any(Object));

    const status = getDatabaseBackupSchedulerStatus();
    expect(status.isRunning).toBe(true);
    expect(status.cronExpression).toBe("0 3 * * *");
  });

  it("does not start if DB_BACKUP_ENABLED is set to false", () => {
    process.env.DB_BACKUP_ENABLED = "false";
    const started = startDatabaseBackupScheduler();

    expect(started).toBe(false);
    expect(isDatabaseBackupSchedulerRunning()).toBe(false);
  });

  it("rejects invalid cron expressions", () => {
    const started = startDatabaseBackupScheduler("invalid-cron");
    expect(started).toBe(false);
    expect(isDatabaseBackupSchedulerRunning()).toBe(false);
  });

  it("stops the scheduler when stopDatabaseBackupScheduler is called", () => {
    startDatabaseBackupScheduler("0 2 * * *");
    expect(isDatabaseBackupSchedulerRunning()).toBe(true);

    stopDatabaseBackupScheduler();
    expect(isDatabaseBackupSchedulerRunning()).toBe(false);
    expect(mockTask.stop).toHaveBeenCalled();
  });

  it("runs the backup job on-demand via runDatabaseBackupNow", async () => {
    const result = await runDatabaseBackupNow();
    expect(mockRunDatabaseBackup).toHaveBeenCalled();
    expect(result.success).toBe(true);
    expect(result.fileName).toBe("job_sync_db_mock.db");
  });

  it("executes the backup when the cron task callback is triggered", async () => {
    startDatabaseBackupScheduler("0 2 * * *");
    expect(scheduledCallback).toBeDefined();

    if (scheduledCallback) {
      await scheduledCallback();
      expect(mockRunDatabaseBackup).toHaveBeenCalled();
    }
  });
});
