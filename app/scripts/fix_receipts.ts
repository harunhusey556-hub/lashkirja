import { prisma } from '../src/lib/db';
import * as path from 'path';
import * as fs from 'fs';
import { randomUUID } from 'crypto';



async function main() {
  const receipts = await prisma.receipt.findMany({
    where: { source: 'email_sync' }
  });

  for (const receipt of receipts) {
    if (receipt.filePath.startsWith('uploads/')) {
      console.log(`Fixing broken receipt: ${receipt.id}`);
      
      const oldStoragePath = path.join(process.cwd(), 'data', receipt.filePath);
      
      // Generate standard safe storage key
      const ext = path.extname(receipt.filePath);
      const safeKey = `${randomUUID()}${ext}`;
      
      // Ensure user directory exists
      const userDir = path.join(process.cwd(), 'data', 'uploads', receipt.userId);
      fs.mkdirSync(userDir, { recursive: true, mode: 0o700 });
      
      const newStoragePath = path.join(userDir, safeKey);
      
      // Copy and delete old file if it exists
      if (fs.existsSync(oldStoragePath)) {
        fs.copyFileSync(oldStoragePath, newStoragePath);
        fs.unlinkSync(oldStoragePath);
      } else {
        console.warn(`Original file not found: ${oldStoragePath}, assigning new path anyway.`);
      }

      // Update upload record
      if (receipt.uploadId) {
        await prisma.upload.update({
          where: { id: receipt.uploadId },
          data: { storageKey: safeKey }
        });
      }

      // Update receipt record
      await prisma.receipt.update({
        where: { id: receipt.id },
        data: { filePath: safeKey }
      });
      console.log(`Successfully migrated receipt ${receipt.id} to ${safeKey}`);
    }
  }
}

main().then(() => {
  console.log('Cleanup complete');
  process.exit(0);
}).catch(console.error);
