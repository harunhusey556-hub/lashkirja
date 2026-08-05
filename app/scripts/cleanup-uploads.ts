import { prisma } from "../src/lib/db";
import { removeUserUpload } from "../src/lib/storage";

/**
 * Sweeps the database for uploads that have expired and have never been claimed 
 * by being attached to a persisted entity (e.g., a Receipt).
 * Also deletes the underlying file from the filesystem.
 */
export async function cleanupExpiredUploads() {
  const expired = await prisma.upload.findMany({
    where: {
      expiresAt: { lt: new Date() },
      claimedAt: null,
    },
    select: {
      id: true,
      userId: true,
      storageKey: true,
    },
  });

  if (expired.length === 0) {
    return { count: 0 };
  }

  let deletedFiles = 0;
  for (const upload of expired) {
    try {
      await removeUserUpload(upload.userId, upload.storageKey, true);
      deletedFiles++;
    } catch (error) {
      console.error(`Failed to remove file for upload ${upload.id}:`, error);
    }
  }

  const result = await prisma.upload.deleteMany({
    where: {
      id: { in: expired.map(e => e.id) },
    },
  });

  return { 
    count: result.count,
    deletedFiles
  };
}

// Allow running directly from command line (e.g. via cron + tsx)
if (require.main === module) {
  cleanupExpiredUploads()
    .then((result) => {
      console.log(`Cleanup complete. Removed ${result.count} DB records and ${result.deletedFiles} files.`);
      process.exit(0);
    })
    .catch((error) => {
      console.error("Cleanup failed:", error);
      process.exit(1);
    });
}
