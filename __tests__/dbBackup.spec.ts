import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import fs from "fs";
import path from "path";
import os from "os";
import {
  formatBackupFileName,
  resolveDatabasePath,
  createDatabaseSnapshot,
  sendBackupEmail,
  uploadBackupToGoogleDrive,
  runDatabaseBackup,
} from "@/lib/backup/dbBackup";

// Mock nodemailer
vi.mock("nodemailer", () => {
  const sendMailMock = vi.fn().mockResolvedValue({ messageId: "mock-message-id-123" });
  return {
    default: {
      createTransport: vi.fn(() => ({
        sendMail: sendMailMock,
      })),
    },
  };
});

// Mock @googleapis/drive
const mockDriveFilesCreate = vi.fn().mockImplementation(async (params: any) => {
  if (params?.media?.body?.destroy) {
    params.media.body.destroy();
  }
  return {
    data: {
      id: "mock-drive-file-id-456",
      name: "job_sync_db_test.db",
      webViewLink: "https://drive.google.com/file/d/mock-drive-file-id-456/view",
    },
  };
});

vi.mock("@googleapis/drive", () => ({
  drive: vi.fn(() => ({
    files: {
      create: mockDriveFilesCreate,
    },
  })),
  auth: {
    GoogleAuth: vi.fn(function () {
      return {};
    }),
    OAuth2: vi.fn(function () {
      return { setCredentials: vi.fn() };
    }),
  },
}));

// Mock db
vi.mock("@/lib/db", () => ({
  default: {
    $executeRawUnsafe: vi.fn().mockResolvedValue(1),
  },
}));

describe("Database Backup Module (dbBackup)", () => {
  const originalEnv = { ...process.env };
  const tempTestFiles: string[] = [];

  beforeEach(() => {
    vi.clearAllMocks();
    process.env = { ...originalEnv };
  });

  afterEach(async () => {
    process.env = originalEnv;
    for (const f of tempTestFiles) {
      if (fs.existsSync(f)) {
        try {
          await fs.promises.unlink(f);
        } catch {
          // ignore
        }
      }
    }
    tempTestFiles.length = 0;
  });

  describe("formatBackupFileName", () => {
    it("generates filename in job_sync_db_<date>_<time>.db format", () => {
      const fileName = formatBackupFileName();
      expect(fileName).toMatch(/^job_sync_db_\d{4}-\d{2}-\d{2}_\d{2}-\d{2}-\d{2}\.db$/);
    });

    it("formats specific fixed date properly", () => {
      // 2026-09-05 15:30:45 UTC
      const fixedDate = new Date("2026-09-05T15:30:45.000Z");
      const fileName = formatBackupFileName(fixedDate, "UTC");
      expect(fileName).toBe("job_sync_db_2026-09-05_15-30-45.db");
    });
  });

  describe("resolveDatabasePath", () => {
    it("strips file: prefix and query params", () => {
      const resolved = resolveDatabasePath("file:/var/data/custom.db?connection_limit=1");
      expect(resolved).toBe("/var/data/custom.db");
    });

    it("resolves default relative path file:./dev.db to an existing db file if present", () => {
      const resolved = resolveDatabasePath("file:./dev.db");
      expect(resolved).toContain("dev.db");
      expect(path.isAbsolute(resolved)).toBe(true);
    });
  });

  describe("createDatabaseSnapshot", () => {
    it("creates a snapshot file at the target path", async () => {
      const tempTarget = path.join(os.tmpdir(), `test-snapshot-${Date.now()}.db`);
      tempTestFiles.push(tempTarget);

      const result = await createDatabaseSnapshot(tempTarget);
      expect(result.path).toBe(tempTarget);
      expect(fs.existsSync(tempTarget)).toBe(true);
      expect(result.size).toBeGreaterThanOrEqual(0);
    });
  });

  describe("sendBackupEmail", () => {
    it("skips sending when Gmail SMTP credentials are not configured", async () => {
      delete process.env.GMAIL_USER;
      delete process.env.GMAIL_APP_PASSWORD;
      delete process.env.SMTP_USER;
      delete process.env.SMTP_PASS;

      const res = await sendBackupEmail({
        filePath: "/dummy/path.db",
        fileName: "job_sync_db_test.db",
        fileSizeBytes: 1024,
      });

      expect(res.attempted).toBe(false);
      expect(res.success).toBe(false);
      expect(res.error).toContain("credentials not configured");
    });

    it("sends email with attachment when Gmail credentials are provided", async () => {
      process.env.GMAIL_USER = "user@gmail.com";
      process.env.GMAIL_APP_PASSWORD = "abcd efgh ijkl mnop";
      process.env.BACKUP_EMAIL_TO = "backup@gmail.com";

      const res = await sendBackupEmail({
        filePath: "/dummy/path.db",
        fileName: "job_sync_db_2026-09-05_12-00-00.db",
        fileSizeBytes: 2048,
      });

      expect(res.attempted).toBe(true);
      expect(res.success).toBe(true);
      expect(res.recipient).toBe("backup@gmail.com");
      expect(res.messageId).toBe("mock-message-id-123");
    });
  });

  describe("uploadBackupToGoogleDrive", () => {
    it("skips upload when Google Drive credentials are not configured", async () => {
      delete process.env.GOOGLE_SERVICE_ACCOUNT_KEY_FILE;
      delete process.env.GOOGLE_SERVICE_ACCOUNT_JSON;
      delete process.env.GOOGLE_SERVICE_ACCOUNT_EMAIL;
      delete process.env.GOOGLE_SERVICE_ACCOUNT_PRIVATE_KEY;
      delete process.env.GOOGLE_DRIVE_REFRESH_TOKEN;

      const res = await uploadBackupToGoogleDrive({
        filePath: "/dummy/path.db",
        fileName: "job_sync_db_test.db",
      });

      expect(res.attempted).toBe(false);
      expect(res.success).toBe(false);
      expect(res.error).toContain("Google Drive credentials not configured");
    });

    it("uploads file to Google Drive when credentials are configured", async () => {
      process.env.GOOGLE_SERVICE_ACCOUNT_JSON = JSON.stringify({
        client_email: "test@sa.iam.gserviceaccount.com",
        private_key: "-----BEGIN PRIVATE KEY-----\nMIIEvgIBADANBgk\n-----END PRIVATE KEY-----",
      });
      process.env.GOOGLE_DRIVE_FOLDER_ID = "folder-123";

      // Create a temporary dummy file to upload
      const dummyFile = path.join(os.tmpdir(), `dummy-upload-${Date.now()}.db`);
      fs.writeFileSync(dummyFile, "sqlite-header-data");
      tempTestFiles.push(dummyFile);

      const res = await uploadBackupToGoogleDrive({
        filePath: dummyFile,
        fileName: "job_sync_db_test.db",
      });

      expect(res.attempted).toBe(true);
      expect(res.success).toBe(true);
      expect(res.fileId).toBe("mock-drive-file-id-456");
      expect(mockDriveFilesCreate).toHaveBeenCalled();
    });
  });

  describe("runDatabaseBackup", () => {
    it("orchestrates backup cycle and cleans up temp file", async () => {
      process.env.GMAIL_USER = "user@gmail.com";
      process.env.GMAIL_APP_PASSWORD = "pass";
      process.env.GOOGLE_DRIVE_REFRESH_TOKEN = "refresh-token";
      process.env.GOOGLE_DRIVE_CLIENT_ID = "client-id";
      process.env.GOOGLE_DRIVE_CLIENT_SECRET = "client-secret";

      const res = await runDatabaseBackup({
        targetFileName: "job_sync_db_test_cycle.db",
      });

      expect(res.fileName).toBe("job_sync_db_test_cycle.db");
      expect(res.fileSizeBytes).toBeGreaterThanOrEqual(0);
      expect(res.email.success).toBe(true);
      expect(res.googleDrive.success).toBe(true);
      expect(res.success).toBe(true);

      // Temporary file should be deleted by default
      const tempPath = path.join(os.tmpdir(), "jobsync-backups", "job_sync_db_test_cycle.db");
      expect(fs.existsSync(tempPath)).toBe(false);
    });
  });
});
