import { prisma } from '../src/lib/db';
import { ImapFlow } from "imapflow";
import { decrypt } from "../src/lib/encryption";
import { simpleParser } from "mailparser";

async function main() {
  const accounts = await prisma.imapAccount.findMany();
  for (const account of accounts) {
    const password = decrypt(account.encryptedPass);
    const client = new ImapFlow({ host: account.host, port: account.port, secure: account.tls, auth: { user: account.email, pass: password }, logger: false });
    await client.connect();
    const lock = await client.getMailboxLock("INBOX");
    try {
      // Find messages from July 9 to July 11
      const messages = client.fetch({ since: new Date("2026-07-09"), before: new Date("2026-07-12") }, { uid: true, envelope: true });
      for await (const msg of messages) {
        if (!msg.envelope?.subject) continue;
        console.log(`[${msg.envelope.date}] Subject: "${msg.envelope.subject}"`);
      }
    } finally {
      lock.release();
      await client.logout();
    }
  }
}
main().catch(console.error);
