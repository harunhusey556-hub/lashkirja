import { expect, it } from 'vitest';
import { enforceAssistantReply, EMPTY_HONESTY, guardStreamReply } from './chat-honesty';
it.each(['I connected your bank.','Bankanızı bağladım.','Lähetin laskun.'])('blocks fabricated completed actions: %s',text=>expect(enforceAssistantReply(text).rejected).toBe(true));
it.each(['https://evil.example/login','//evil.example','javascript:alert(1)','/admin','/kuitit/kuitti?id=another-account'])('blocks injected action destinations %s',href=>expect(enforceAssistantReply(`[Open](${href})`).rejected).toBe(true));
it('rejects invented financial figures in streamed output',()=>expect(guardStreamReply({status:'complete',content:'Your receipts total 999,00 €.'},EMPTY_HONESTY).rejected).toBe(true));
