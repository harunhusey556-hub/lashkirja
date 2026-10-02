import { expect, it } from "vitest";
import { parseChatSearch } from "./chat-search";
it("uses inclusive user end dates and exclusive database bounds",()=>expect(parseChatSearch('laskut 2026-09-01 – 2026-09-30')).toEqual({from:'2026-09-01',until:'2026-10-01'}));
it("finds a quoted customer and invoice without parsing a date as a number",()=>expect(parseChatSearch('customer "Anna" invoice #42 2026-09')).toEqual({customer:'Anna',invoiceNumber:42,from:'2026-09-01',until:'2026-10-01'}));
it.each(['2026-02-30','2026-13','2026-09-30 to 2026-09-01'])('does not silently ignore invalid dates %s',text=>expect(parseChatSearch(text).invalidDate).toBe(true));
it.each(['viime kuun laskut','last month receipts','geçen ay faturalar'])('understands relative month %s',text=>expect(parseChatSearch(text,new Date('2026-10-02T10:00:00Z'))).toEqual({from:'2026-09-01',until:'2026-10-01'}));
it('understands Finnish month names with an explicit year',()=>expect(parseChatSearch('syyskuun 2025 kuitit')).toEqual({from:'2025-09-01',until:'2025-10-01'}));
