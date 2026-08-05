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
    let lock = await client.getMailboxLock("INBOX");
    try {
      // Just check the entire July for ANY email with attachments named yth or kuitti
      const messages = client.fetch({ since: new Date("2026-07-01") }, { uid: true, envelope: true, source: true });
      for await (const msg of messages) {
        if (!msg.source) continue;
        const parsed = await simpleParser(msg.source);
        for (const att of parsed.attachments) {
          if (att.filename && att.filename.toLowerCase().includes("yth")) {
            console.log(`BINGO! Subject: "${msg.envelope?.subject}", Attachment: ${att.filename}`);
          }
        }
      }
    } finally {
      lock.release();
      await client.logout();
    }
  }
}
main().catch(console.error);
