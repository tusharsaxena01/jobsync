import fs from "fs";
import path from "path";
import os from "os";
import nodemailer from "nodemailer";
import { drive, auth as googleAuth } from "@googleapis/drive";
import { DB_BACKUP_CONSTANTS } from "@/lib/constants";

export interface EmailBackupResult {
  attempted: boolean;
  success: boolean;
  recipient?: string;
  messageId?: string;
  error?: string;
}

export interface DriveBackupResult {
  attempted: boolean;
  success: boolean;
  fileId?: string;
  name?: string;
  webViewLink?: string;
  folderId?: string;
  error?: string;
}

export interface DatabaseBackupResult {
  success: boolean;
  fileName: string;
  fileSizeBytes: number;
  dbSourcePath: string;
  snapshotPath?: string;
  timestamp: string;
  email: EmailBackupResult;
  googleDrive: DriveBackupResult;
  durationMs: number;
  error?: string;
}

export interface RunBackupOptions {
  dbUrl?: string;
  emailRecipient?: string;
  driveFolderId?: string;
  keepLocal?: boolean;
  targetFileName?: string;
}

/**
 * Formats the database backup filename in the requested format:
 * job_sync_db_<date>_<time>.db
 * Example: job_sync_db_2026-09-05_22-30-00.db
 */
export function formatBackupFileName(date: Date = new Date(), timeZone?: string): string {
  const tz = timeZone || process.env.TZ;
  const formatter = new Intl.DateTimeFormat("en-CA", {
    timeZone: tz || undefined,
    year: "numeric",
    month: "2-digit",
    day: "2-digit",
    hour: "2-digit",
    minute: "2-digit",
    second: "2-digit",
    hour12: false,
  });

  const parts = formatter.formatToParts(date);
  const find = (type: string) => parts.find((p) => p.type === type)?.value ?? "00";

  const year = find("year");
  const month = find("month");
  const day = find("day");
  const hour = find("hour");
  const minute = find("minute");
  const second = find("second");

  return `${DB_BACKUP_CONSTANTS.FILE_PREFIX}${year}-${month}-${day}_${hour}-${minute}-${second}.db`;
}

/**
 * Resolves the active SQLite database path from DATABASE_URL.
 * Supports relative, absolute, and Prisma schema folder layouts.
 */
export function resolveDatabasePath(rawUrl?: string): string {
  const dbUrl = rawUrl || process.env.DATABASE_URL || "file:./dev.db";
  let cleanPath = dbUrl;

  if (cleanPath.startsWith("file:")) {
    cleanPath = cleanPath.slice(5);
  }

  // Strip query parameters (e.g. ?connection_limit=1)
  const qIndex = cleanPath.indexOf("?");
  if (qIndex !== -1) {
    cleanPath = cleanPath.substring(0, qIndex);
  }

  if (path.isAbsolute(cleanPath)) {
    return cleanPath;
  }

  const rootCandidate = path.resolve(process.cwd(), cleanPath);
  const prismaCandidate = path.resolve(process.cwd(), "prisma", cleanPath);

  const rootStat = fs.existsSync(rootCandidate) ? fs.statSync(rootCandidate) : null;
  const prismaStat = fs.existsSync(prismaCandidate) ? fs.statSync(prismaCandidate) : null;

  // Prefer the candidate with content if one exists
  if (prismaStat && prismaStat.size > 0) {
    return prismaCandidate;
  }
  if (rootStat && rootStat.size > 0) {
    return rootCandidate;
  }
  if (prismaStat) {
    return prismaCandidate;
  }
  if (rootStat) {
    return rootCandidate;
  }

  return prismaCandidate;
}

/**
 * Creates a consistent SQLite database snapshot at targetPath.
 * Attempts SQLite VACUUM INTO via Prisma client, falling back to safe file copy.
 */
export async function createDatabaseSnapshot(
  targetPath: string,
  sourcePath?: string,
): Promise<{ path: string; size: number }> {
  const resolvedSource = sourcePath || resolveDatabasePath();

  if (!fs.existsSync(resolvedSource)) {
    throw new Error(`Database file not found at source path: ${resolvedSource}`);
  }

  // Ensure target directory exists
  const targetDir = path.dirname(targetPath);
  await fs.promises.mkdir(targetDir, { recursive: true });

  // SQLite VACUUM INTO requires the target file to not exist
  if (fs.existsSync(targetPath)) {
    await fs.promises.unlink(targetPath);
  }

  let snapshotCreated = false;

  // Attempt 1: Safe atomic VACUUM INTO via Prisma
  try {
    const dbModule = await import("@/lib/db");
    const prisma = dbModule.default;
    if (prisma && typeof prisma.$executeRawUnsafe === "function") {
      const escapedTarget = targetPath.replace(/'/g, "''");
      await prisma.$executeRawUnsafe(`VACUUM INTO '${escapedTarget}'`);
      snapshotCreated = true;
    }
  } catch (vacuumError) {
    console.warn("[Backup] VACUUM INTO attempt failed, falling back to direct file copy:", vacuumError);
  }

  // Attempt 2: Fallback to direct file copy
  if (!snapshotCreated || !fs.existsSync(targetPath)) {
    await fs.promises.copyFile(resolvedSource, targetPath);
  }

  const stat = await fs.promises.stat(targetPath);
  return { path: targetPath, size: stat.size };
}

/**
 * Sends the database backup as an attachment to email using Gmail SMTP.
 */
export async function sendBackupEmail(options: {
  filePath: string;
  fileName: string;
  fileSizeBytes: number;
  recipient?: string;
}): Promise<EmailBackupResult> {
  const user = process.env.GMAIL_USER || process.env.SMTP_USER;
  const pass = (process.env.GMAIL_APP_PASSWORD || process.env.SMTP_PASS || "").replace(/\s+/g, "");
  const recipient = options.recipient || process.env.BACKUP_EMAIL_TO || user;
  console.log({user, pass})
  if (!user || !pass) {
    console.warn("[Backup] Skipping email: GMAIL_USER/SMTP_USER or GMAIL_APP_PASSWORD/SMTP_PASS is not configured.");
    return {
      attempted: false,
      success: false,
      error: "Gmail SMTP credentials not configured (GMAIL_USER / GMAIL_APP_PASSWORD missing).",
    };
  }

  if (!recipient) {
    console.warn("[Backup] Skipping email: No recipient address specified (BACKUP_EMAIL_TO missing).");
    return {
      attempted: false,
      success: false,
      error: "No recipient email configured.",
    };
  }

  const host = process.env.SMTP_HOST || DB_BACKUP_CONSTANTS.DEFAULT_SMTP_HOST;
  const port = Number(process.env.SMTP_PORT) || DB_BACKUP_CONSTANTS.DEFAULT_SMTP_PORT;
  const secure = process.env.SMTP_PORT ? port === 465 : true;

  try {
    const transporter = nodemailer.createTransport({
      host,
      port,
      secure,
      auth: { user, pass },
    });

    const sizeFormatted = (options.fileSizeBytes / (1024 * 1024)).toFixed(2) + " MB";
    const nowIso = new Date().toISOString();

    const info = await transporter.sendMail({
      from: `"JobSync Backup" <${user}>`,
      to: recipient,
      subject: `JobSync Database Backup: ${options.fileName}`,
      text: `Your automated JobSync database backup is attached.\n\nFile Name: ${options.fileName}\nSize: ${sizeFormatted}\nCreated At: ${nowIso}\nSource: ${process.env.DATABASE_URL || "file:./dev.db"}`,
      html: `
        <div style="font-family: Arial, sans-serif; max-width: 600px; padding: 20px; border: 1px solid #e2e8f0; border-radius: 8px;">
          <h2 style="color: #2563eb; margin-top: 0;">JobSync Database Backup</h2>
          <p>Your automated database backup was created successfully and is attached below.</p>
          <table style="width: 100%; border-collapse: collapse; margin: 16px 0;">
            <tr>
              <td style="padding: 8px; border-bottom: 1px solid #f1f5f9; font-weight: bold; width: 140px;">File Name:</td>
              <td style="padding: 8px; border-bottom: 1px solid #f1f5f9; font-family: monospace;">${options.fileName}</td>
            </tr>
            <tr>
              <td style="padding: 8px; border-bottom: 1px solid #f1f5f9; font-weight: bold;">Size:</td>
              <td style="padding: 8px; border-bottom: 1px solid #f1f5f9;">${sizeFormatted}</td>
            </tr>
            <tr>
              <td style="padding: 8px; border-bottom: 1px solid #f1f5f9; font-weight: bold;">Timestamp:</td>
              <td style="padding: 8px; border-bottom: 1px solid #f1f5f9;">${nowIso}</td>
            </tr>
            <tr>
              <td style="padding: 8px; border-bottom: 1px solid #f1f5f9; font-weight: bold;">Source:</td>
              <td style="padding: 8px; border-bottom: 1px solid #f1f5f9; font-family: monospace;">${process.env.DATABASE_URL || "file:./dev.db"}</td>
            </tr>
          </table>
          <p style="font-size: 12px; color: #64748b; margin-bottom: 0;">Automated backup sent via JobSync cron scheduler.</p>
        </div>
      `,
      attachments: [
        {
          filename: options.fileName,
          path: options.filePath,
          contentType: DB_BACKUP_CONSTANTS.MIME_TYPE,
        },
      ],
    });

    return {
      attempted: true,
      success: true,
      recipient,
      messageId: info.messageId,
    };
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    console.error("[Backup] Failed to send backup email via Gmail SMTP:", message);
    return {
      attempted: true,
      success: false,
      recipient,
      error: message,
    };
  }
}

/**
 * Creates an authenticated Google Drive client supporting:
 * 1) Service Account key file (GOOGLE_SERVICE_ACCOUNT_KEY_FILE / GOOGLE_APPLICATION_CREDENTIALS)
 * 2) Service Account JSON string (GOOGLE_SERVICE_ACCOUNT_JSON)
 * 3) Service Account Email & Private Key (GOOGLE_SERVICE_ACCOUNT_EMAIL & GOOGLE_SERVICE_ACCOUNT_PRIVATE_KEY)
 * 4) OAuth2 Refresh Token (GOOGLE_DRIVE_CLIENT_ID, GOOGLE_DRIVE_CLIENT_SECRET, GOOGLE_DRIVE_REFRESH_TOKEN)
 */
export function createGoogleDriveClient() {
  const scopes = ["https://www.googleapis.com/auth/drive.file"];

  // 1. Service Account JSON file path
  const keyFile = process.env.GOOGLE_SERVICE_ACCOUNT_KEY_FILE || process.env.GOOGLE_APPLICATION_CREDENTIALS;
  if (keyFile && fs.existsSync(keyFile)) {
    const auth = new googleAuth.GoogleAuth({
      keyFile,
      scopes,
    });
    return drive({ version: "v3", auth });
  }

  // 2. Service Account raw JSON string
  const jsonCredentials = process.env.GOOGLE_SERVICE_ACCOUNT_JSON;
  if (jsonCredentials) {
    try {
      const credentials = typeof jsonCredentials === "string" ? JSON.parse(jsonCredentials) : jsonCredentials;
      const auth = new googleAuth.GoogleAuth({
        credentials,
        scopes,
      });
      return drive({ version: "v3", auth });
    } catch (parseErr) {
      console.error("[Backup] Failed to parse GOOGLE_SERVICE_ACCOUNT_JSON:", parseErr);
    }
  }

  // 3. Service Account Email & Private Key
  const saEmail = process.env.GOOGLE_SERVICE_ACCOUNT_EMAIL || process.env.GOOGLE_CLIENT_EMAIL;
  const saKey = process.env.GOOGLE_SERVICE_ACCOUNT_PRIVATE_KEY || process.env.GOOGLE_PRIVATE_KEY;
  if (saEmail && saKey) {
    const privateKey = saKey.replace(/\\n/g, "\n");
    const auth = new googleAuth.GoogleAuth({
      credentials: {
        client_email: saEmail,
        private_key: privateKey,
      },
      scopes,
    });
    return drive({ version: "v3", auth });
  }

  // 4. OAuth2 Refresh Token
  const clientId = process.env.GOOGLE_DRIVE_CLIENT_ID;
  const clientSecret = process.env.GOOGLE_DRIVE_CLIENT_SECRET;
  const refreshToken = process.env.GOOGLE_DRIVE_REFRESH_TOKEN;
  if (clientId && refreshToken) {
    const oauth2Client = new googleAuth.OAuth2(clientId, clientSecret);
    oauth2Client.setCredentials({ refresh_token: refreshToken });
    return drive({ version: "v3", auth: oauth2Client });
  }

  return null;
}

/**
 * Uploads the database backup file to Google Drive.
 */
export async function uploadBackupToGoogleDrive(options: {
  filePath: string;
  fileName: string;
  folderId?: string;
}): Promise<DriveBackupResult> {
  const driveClient = createGoogleDriveClient();
  const folderId = options.folderId || process.env.GOOGLE_DRIVE_FOLDER_ID;

  if (!driveClient) {
    console.warn(
      "[Backup] Skipping Google Drive upload: No Google credentials found (configure GOOGLE_SERVICE_ACCOUNT_KEY_FILE, GOOGLE_SERVICE_ACCOUNT_JSON, GOOGLE_SERVICE_ACCOUNT_EMAIL/KEY, or GOOGLE_DRIVE_REFRESH_TOKEN).",
    );
    return {
      attempted: false,
      success: false,
      error: "Google Drive credentials not configured.",
    };
  }

  try {
    const fileMetadata: { name: string; parents?: string[] } = {
      name: options.fileName,
    };
    if (folderId) {
      fileMetadata.parents = [folderId];
    }

    const fileStream = fs.createReadStream(options.filePath);
    fileStream.on("error", (streamErr) => {
      console.warn("[Backup] Read stream notice:", streamErr.message);
    });

    const media = {
      mimeType: DB_BACKUP_CONSTANTS.MIME_TYPE,
      body: fileStream,
    };

    const response = await driveClient.files.create({
      requestBody: fileMetadata,
      media,
      fields: "id, name, webViewLink",
    });

    return {
      attempted: true,
      success: true,
      fileId: response.data.id ?? undefined,
      name: response.data.name ?? options.fileName,
      webViewLink: response.data.webViewLink ?? undefined,
      folderId,
    };
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    console.error("[Backup] Failed to upload database backup to Google Drive:", message);
    return {
      attempted: true,
      success: false,
      folderId,
      error: message,
    };
  }
}

/**
 * Executes a full database backup cycle:
 * 1. Resolves database source path
 * 2. Generates formatted filename: job_sync_db_<date>_<time>.db
 * 3. Creates clean snapshot
 * 4. Sends snapshot to email using Gmail SMTP
 * 5. Uploads snapshot to Google Drive
 * 6. Cleans up temporary snapshot file
 */
export async function runDatabaseBackup(options: RunBackupOptions = {}): Promise<DatabaseBackupResult> {
  const startTime = Date.now();
  const timestamp = new Date().toISOString();
  const fileName = options.targetFileName || formatBackupFileName();
  const sourcePath = resolveDatabasePath(options.dbUrl);

  const tempDir = path.join(os.tmpdir(), "jobsync-backups");
  const tempSnapshotPath = path.join(tempDir, fileName);

  let fileSizeBytes = 0;
  let emailResult: EmailBackupResult = { attempted: false, success: false };
  let driveResult: DriveBackupResult = { attempted: false, success: false };

  try {
    console.log(`[Backup] Starting database backup: ${fileName} from source: ${sourcePath}`);

    // Create snapshot
    const snapshot = await createDatabaseSnapshot(tempSnapshotPath, sourcePath);
    fileSizeBytes = snapshot.size;
    console.log(`[Backup] Snapshot created: ${tempSnapshotPath} (${fileSizeBytes} bytes)`);

    // Step 1: Send to Email using Gmail SMTP
    emailResult = await sendBackupEmail({
      filePath: tempSnapshotPath,
      fileName,
      fileSizeBytes,
      recipient: options.emailRecipient,
    });
    if (emailResult.success) {
      console.log(`[Backup] Email sent successfully to ${emailResult.recipient}`);
    } else if (emailResult.attempted) {
      console.warn(`[Backup] Email sending failed: ${emailResult.error}`);
    }

    // Step 2: Upload to Google Drive
    driveResult = await uploadBackupToGoogleDrive({
      filePath: tempSnapshotPath,
      fileName,
      folderId: options.driveFolderId,
    });
    if (driveResult.success) {
      console.log(`[Backup] Uploaded to Google Drive: ${driveResult.name} (id: ${driveResult.fileId})`);
    } else if (driveResult.attempted) {
      console.warn(`[Backup] Google Drive upload failed: ${driveResult.error}`);
    }

    // Consider overall backup successful if at least one destination succeeded,
    // or if neither destination is configured yet, snapshot creation itself succeeded.
    const overallSuccess =
      (emailResult.attempted ? emailResult.success : true) &&
      (driveResult.attempted ? driveResult.success : true) &&
      (emailResult.attempted || driveResult.attempted);

    return {
      success: overallSuccess,
      fileName,
      fileSizeBytes,
      dbSourcePath: sourcePath,
      snapshotPath: options.keepLocal ? tempSnapshotPath : undefined,
      timestamp,
      email: emailResult,
      googleDrive: driveResult,
      durationMs: Date.now() - startTime,
    };
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    console.error(`[Backup] Backup failed:`, message);
    return {
      success: false,
      fileName,
      fileSizeBytes,
      dbSourcePath: sourcePath,
      timestamp,
      email: emailResult,
      googleDrive: driveResult,
      durationMs: Date.now() - startTime,
      error: message,
    };
  } finally {
    // Clean up temporary snapshot unless explicitly requested to keep
    if (!options.keepLocal && fs.existsSync(tempSnapshotPath)) {
      try {
        await fs.promises.unlink(tempSnapshotPath);
      } catch (cleanupErr) {
        console.warn(`[Backup] Failed to remove temp snapshot:`, cleanupErr);
      }
    }
  }
}
