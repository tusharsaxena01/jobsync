import { auth } from "@/auth";
import { NextResponse } from "next/server";
import {
  getDatabaseBackupSchedulerStatus,
  runDatabaseBackupNow,
} from "@/lib/scheduler";

export async function GET() {
  const session = await auth();
  if (!session?.user?.id) {
    return NextResponse.json({ error: "Not authenticated" }, { status: 401 });
  }

  try {
    const status = getDatabaseBackupSchedulerStatus();
    return NextResponse.json(status, { status: 200 });
  } catch (error) {
    console.error("[Backup] Failed to get backup scheduler status:", error);
    return NextResponse.json({ error: "Failed to retrieve status" }, { status: 500 });
  }
}

export async function POST(req: Request) {
  const session = await auth();
  if (!session?.user?.id) {
    return NextResponse.json({ error: "Not authenticated" }, { status: 401 });
  }

  try {
    let body: { emailRecipient?: string; driveFolderId?: string } = {};
    try {
      body = await req.json();
    } catch {
      // Empty or invalid body is acceptable; defaults will be used
    }

    const result = await runDatabaseBackupNow({
      emailRecipient: body.emailRecipient || session.user.email || undefined,
      driveFolderId: body.driveFolderId,
    });

    return NextResponse.json(result, { status: result.success ? 200 : 500 });
  } catch (error) {
    const message = error instanceof Error ? error.message : "Backup failed";
    console.error("[Backup] Database backup execution failed:", error);
    return NextResponse.json({ error: message }, { status: 500 });
  }
}
