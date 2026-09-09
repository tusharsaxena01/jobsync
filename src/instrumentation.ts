export async function register() {
  if (process.env.NEXT_RUNTIME === "nodejs") {
    const { syncSchedulerState, startDatabaseBackupScheduler } = await import("@/lib/scheduler");
    await syncSchedulerState();
    startDatabaseBackupScheduler();
  }
}
