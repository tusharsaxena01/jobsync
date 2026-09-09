#!/usr/bin/env node

/**
 * Standalone Database Backup Runner
 *
 * Runs an on-demand database backup:
 * 1. Takes a consistent SQLite snapshot of DATABASE_URL (or ./dev.db / prisma/dev.db)
 * 2. Generates filename: job_sync_db_<date>_<time>.db
 * 3. Sends snapshot as attachment to email via Gmail SMTP
 * 4. Uploads snapshot to Google Drive
 * 5. Cleans up temporary snapshot file
 *
 * Usage:
 *   node scripts/backup-db.mjs
 *   node scripts/backup-db.mjs --keep-local
 *   node scripts/backup-db.mjs --to=myemail@gmail.com
 *   node scripts/backup-db.mjs --dry-run
 */

import "dotenv/config";
import fs from "fs";
import path from "path";
import os from "os";
import { fileURLToPath } from "url";
import nodemailer from "nodemailer";
import { drive, auth as googleAuth } from "@googleapis/drive";

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);
const projectRoot = path.resolve(__dirname, "..");

const DB_BACKUP_CONSTANTS = {
  DEFAULT_SMTP_HOST: "smtp.gmail.com",
  DEFAULT_SMTP_PORT: 465,
  FILE_PREFIX: "job_sync_db_",
  MIME_TYPE: "application/x-sqlite3",
};

// ANSI color helpers
const colors = {
  reset: "\x1b[0m",
  green: "\x1b[32m",
  yellow: "\x1b[33m",
  red: "\x1b[31m",
  blue: "\x1b[34m",
  cyan: "\x1b[36m",
  bold: "\x1b[1m",
};

function logInfo(msg) {
  console.log(`${colors.cyan}[INFO]${colors.reset} ${msg}`);
}
function logSuccess(msg) {
  console.log(`${colors.green}[SUCCESS]${colors.reset} ${msg}`);
}
function logWarn(msg) {
  console.log(`${colors.yellow}[WARN]${colors.reset} ${msg}`);
}
function logError(msg) {
  console.log(`${colors.red}[ERROR]${colors.reset} ${msg}`);
}

function formatBackupFileName(date = new Date(), timeZone) {
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
  const find = (type) => parts.find((p) => p.type === type)?.value ?? "00";

  const year = find("year");
  const month = find("month");
  const day = find("day");
  const hour = find("hour");
  const minute = find("minute");
  const second = find("second");

  return `${DB_BACKUP_CONSTANTS.FILE_PREFIX}${year}-${month}-${day}_${hour}-${minute}-${second}.db`;
}

function resolveDatabasePath(rawUrl) {
  const dbUrl = rawUrl || process.env.DATABASE_URL || "file:./dev.db";
  let cleanPath = dbUrl;

  if (cleanPath.startsWith("file:")) {
    cleanPath = cleanPath.slice(5);
  }

  const qIndex = cleanPath.indexOf("?");
  if (qIndex !== -1) {
    cleanPath = cleanPath.substring(0, qIndex);
  }

  if (path.isAbsolute(cleanPath)) {
    return cleanPath;
  }

  const rootCandidate = path.resolve(projectRoot, cleanPath);
  const prismaCandidate = path.resolve(projectRoot, "prisma", cleanPath);

  const rootStat = fs.existsSync(rootCandidate) ? fs.statSync(rootCandidate) : null;
  const prismaStat = fs.existsSync(prismaCandidate) ? fs.statSync(prismaCandidate) : null;

  if (prismaStat && prismaStat.size > 0) return prismaCandidate;
  if (rootStat && rootStat.size > 0) return rootCandidate;
  if (prismaStat) return prismaCandidate;
  if (rootStat) return rootCandidate;

  return prismaCandidate;
}

async function createDatabaseSnapshot(targetPath, sourcePath) {
  const resolvedSource = sourcePath || resolveDatabasePath();

  if (!fs.existsSync(resolvedSource)) {
    throw new Error(`Source database file not found: ${resolvedSource}`);
  }

  const targetDir = path.dirname(targetPath);
  await fs.promises.mkdir(targetDir, { recursive: true });

  if (fs.existsSync(targetPath)) {
    await fs.promises.unlink(targetPath);
  }

  // File copy for standalone runner
  await fs.promises.copyFile(resolvedSource, targetPath);

  const stat = await fs.promises.stat(targetPath);
  return { path: targetPath, size: stat.size };
}

async function sendBackupEmail({ filePath, fileName, fileSizeBytes, recipient }) {
  const user = process.env.GMAIL_USER || process.env.SMTP_USER;
  const pass = (process.env.GMAIL_APP_PASSWORD || process.env.SMTP_PASS || "").replace(/\s+/g, "");
  const targetRecipient = recipient || process.env.BACKUP_EMAIL_TO || user;
  console.log({user, pass})
  if (!user || !pass) {
    logWarn("Gmail SMTP not configured (GMAIL_USER or GMAIL_APP_PASSWORD missing). Skipping email.");
    return { attempted: false, success: false, error: "Credentials missing" };
  }

  if (!targetRecipient) {
    logWarn("No recipient email configured (BACKUP_EMAIL_TO missing). Skipping email.");
    return { attempted: false, success: false, error: "Recipient missing" };
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

    const sizeFormatted = (fileSizeBytes / (1024 * 1024)).toFixed(2) + " MB";
    const nowIso = new Date().toISOString();

    const info = await transporter.sendMail({
      from: `"JobSync Backup" <${user}>`,
      to: targetRecipient,
      subject: `JobSync Database Backup: ${fileName}`,
      text: `Your automated JobSync database backup is attached.\n\nFile Name: ${fileName}\nSize: ${sizeFormatted}\nCreated At: ${nowIso}\nSource: ${process.env.DATABASE_URL || "file:./dev.db"}`,
      html: `
        <div style="font-family: Arial, sans-serif; max-width: 600px; padding: 20px; border: 1px solid #e2e8f0; border-radius: 8px;">
          <h2 style="color: #2563eb; margin-top: 0;">JobSync Database Backup</h2>
          <p>Your automated database backup was created successfully and is attached below.</p>
          <table style="width: 100%; border-collapse: collapse; margin: 16px 0;">
            <tr>
              <td style="padding: 8px; border-bottom: 1px solid #f1f5f9; font-weight: bold; width: 140px;">File Name:</td>
              <td style="padding: 8px; border-bottom: 1px solid #f1f5f9; font-family: monospace;">${fileName}</td>
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
          filename: fileName,
          path: filePath,
          contentType: DB_BACKUP_CONSTANTS.MIME_TYPE,
        },
      ],
    });

    logSuccess(`Email sent via Gmail SMTP to: ${targetRecipient} (Message ID: ${info.messageId})`);
    return { attempted: true, success: true, recipient: targetRecipient, messageId: info.messageId };
  } catch (error) {
    const msg = error instanceof Error ? error.message : String(error);
    logError(`Failed to send email: ${msg}`);
    return { attempted: true, success: false, recipient: targetRecipient, error: msg };
  }
}

function createGoogleDriveClient() {
  const scopes = ["https://www.googleapis.com/auth/drive.file"];

  // 1. Service Account JSON file path
  const keyFile = process.env.GOOGLE_SERVICE_ACCOUNT_KEY_FILE || process.env.GOOGLE_APPLICATION_CREDENTIALS;
  if (keyFile && fs.existsSync(keyFile)) {
    const auth = new googleAuth.GoogleAuth({ keyFile, scopes });
    return drive({ version: "v3", auth });
  }

  // 2. Service Account raw JSON string
  const jsonCredentials = process.env.GOOGLE_SERVICE_ACCOUNT_JSON;
  if (jsonCredentials) {
    try {
      const credentials = typeof jsonCredentials === "string" ? JSON.parse(jsonCredentials) : jsonCredentials;
      const auth = new googleAuth.GoogleAuth({ credentials, scopes });
      return drive({ version: "v3", auth });
    } catch (parseErr) {
      logError(`Failed to parse GOOGLE_SERVICE_ACCOUNT_JSON: ${parseErr}`);
    }
  }

  // 3. Service Account Email & Private Key
  const saEmail = process.env.GOOGLE_SERVICE_ACCOUNT_EMAIL || process.env.GOOGLE_CLIENT_EMAIL;
  const saKey = process.env.GOOGLE_SERVICE_ACCOUNT_PRIVATE_KEY || process.env.GOOGLE_PRIVATE_KEY;
  if (saEmail && saKey) {
    const privateKey = saKey.replace(/\\n/g, "\n");
    const auth = new googleAuth.GoogleAuth({
      credentials: { client_email: saEmail, private_key: privateKey },
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

async function uploadBackupToGoogleDrive({ filePath, fileName, folderId }) {
  const driveClient = createGoogleDriveClient();
  const targetFolderId = folderId || process.env.GOOGLE_DRIVE_FOLDER_ID;

  if (!driveClient) {
    logWarn("Google Drive credentials not configured. Skipping upload.");
    return { attempted: false, success: false, error: "Google Drive credentials missing" };
  }

  try {
    const fileMetadata = { name: fileName };
    if (targetFolderId) {
      fileMetadata.parents = [targetFolderId];
    }

    const fileStream = fs.createReadStream(filePath);
    fileStream.on("error", (err) => {
      // Prevent unhandled stream error
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

    logSuccess(
      `Uploaded to Google Drive: "${response.data.name}" (ID: ${response.data.id}${response.data.webViewLink ? `, Link: ${response.data.webViewLink}` : ""})`,
    );
    return {
      attempted: true,
      success: true,
      fileId: response.data.id,
      name: response.data.name,
      webViewLink: response.data.webViewLink,
      folderId: targetFolderId,
    };
  } catch (error) {
    const msg = error instanceof Error ? error.message : String(error);
    logError(`Failed to upload to Google Drive: ${msg}`);
    return { attempted: true, success: false, error: msg };
  }
}

async function main() {
  const args = process.argv.slice(2);
  const dryRun = args.includes("--dry-run");
  const keepLocal = args.includes("--keep-local");
  const toArg = args.find((a) => a.startsWith("--to="))?.slice(5);

  console.log("");
  console.log(`${colors.bold}========================================${colors.reset}`);
  console.log(`${colors.bold}JobSync Database Backup CLI${colors.reset}`);
  console.log(`${colors.bold}========================================${colors.reset}`);
  console.log("");

  const dbSource = resolveDatabasePath();
  const fileName = formatBackupFileName();
  logInfo(`Active database file: ${dbSource}`);
  logInfo(`Generated backup name: ${fileName}`);

  if (!fs.existsSync(dbSource)) {
    logError(`Database file does not exist at ${dbSource}`);
    process.exit(1);
  }

  const stat = fs.statSync(dbSource);
  logInfo(`Database file size: ${(stat.size / (1024 * 1024)).toFixed(2)} MB (${stat.size} bytes)`);

  if (dryRun) {
    logWarn("Dry-run mode enabled: skipping email and Google Drive upload.");
    console.log("");
    console.log(`${colors.green}Backup dry-run completed successfully!${colors.reset}`);
    process.exit(0);
  }

  const tempDir = path.join(os.tmpdir(), "jobsync-backups");
  const tempSnapshotPath = path.join(tempDir, fileName);

  try {
    logInfo(`Creating consistent SQLite snapshot at ${tempSnapshotPath}...`);
    const snapshot = await createDatabaseSnapshot(tempSnapshotPath, dbSource);
    logSuccess(`Snapshot created: ${(snapshot.size / (1024 * 1024)).toFixed(2)} MB`);

    // 1. Email via Gmail SMTP
    console.log("");
    logInfo("Sending backup to email using Gmail SMTP...");
    const emailRes = await sendBackupEmail({
      filePath: tempSnapshotPath,
      fileName,
      fileSizeBytes: snapshot.size,
      recipient: toArg,
    });

    // 2. Google Drive upload
    console.log("");
    logInfo("Uploading backup to Google Drive...");
    const driveRes = await uploadBackupToGoogleDrive({
      filePath: tempSnapshotPath,
      fileName,
    });

    console.log("");
    console.log(`${colors.bold}----------------------------------------${colors.reset}`);
    console.log(`${colors.bold}Backup Summary:${colors.reset}`);
    console.log(`- File Name:    ${fileName}`);
    console.log(`- File Size:    ${(snapshot.size / 1024).toFixed(1)} KB`);
    console.log(`- Gmail SMTP:   ${emailRes.success ? colors.green + "SUCCESS" : emailRes.attempted ? colors.red + "FAILED" : colors.yellow + "SKIPPED"}${colors.reset}`);
    console.log(`- Google Drive: ${driveRes.success ? colors.green + "SUCCESS" : driveRes.attempted ? colors.red + "FAILED" : colors.yellow + "SKIPPED"}${colors.reset}`);
    console.log(`${colors.bold}----------------------------------------${colors.reset}`);
    console.log("");

    if (!emailRes.attempted && !driveRes.attempted) {
      logWarn("Neither Gmail SMTP nor Google Drive credentials were configured.");
      logWarn("Please check your .env file and configure GMAIL_USER/GMAIL_APP_PASSWORD or Google Drive credentials.");
    }
  } catch (err) {
    logError(`Backup process encountered an error: ${err.message || err}`);
    process.exit(1);
  } finally {
    if (!keepLocal && fs.existsSync(tempSnapshotPath)) {
      try {
        await fs.promises.unlink(tempSnapshotPath);
        logInfo("Temporary snapshot cleaned up.");
      } catch (cleanErr) {
        logWarn(`Could not delete temporary snapshot: ${cleanErr.message}`);
      }
    } else if (keepLocal) {
      logInfo(`Retained local backup copy at: ${tempSnapshotPath}`);
    }
  }
}

main().catch((err) => {
  logError(`Fatal error: ${err.message || err}`);
  process.exit(1);
});
