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
      const messages = client.fetch({ since: new Date("2026-07-09"), before: new Date("2026-07-12") }, { uid: true, envelope: true, source: true });
      for await (const msg of messages) {
        if (msg.envelope?.subject && msg.envelope.subject.toLowerCase().includes("viesteiss")) {
          if (!msg.source) continue;
          const parsed = await simpleParser(msg.source);
          console.log(`Subject: ${msg.envelope.subject}`);
          console.log(`Attachments count: ${parsed.attachments.length}`);
          console.log(`Text snippet: ${parsed.text?.substring(0, 200)}`);
        }
      }
    } finally {
      lock.release();
      await client.logout();
    }
  }
}
main().catch(console.error);
