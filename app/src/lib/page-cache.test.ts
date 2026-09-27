import { afterEach, describe, expect, it } from "vitest";
import {
  PAGE_CACHE_MAX_ENTRIES,
  PAGE_CACHE_TTL_MS,
  clearPageCache,
  pageCacheSize,
  readPageCache,
  writePageCache,
} from "@/lib/page-cache";

afterEach(() => {
  clearPageCache();
});

describe("page cache bounds", () => {
  it("drops a copy after the TTL", () => {
    const at = 1_700_000_000_000;
    writePageCache("receipts", { rows: 1 }, at);
    expect(readPageCache("receipts", at + PAGE_CACHE_TTL_MS)).toEqual({ rows: 1 });
    expect(readPageCache("receipts", at + PAGE_CACHE_TTL_MS + 1)).toBeNull();
  });

  it("keeps only the newest entries", () => {
    for (let index = 0; index < PAGE_CACHE_MAX_ENTRIES + 5; index += 1) {
      writePageCache(`key-${index}`, index, 1_000 + index);
    }
    expect(pageCacheSize()).toBe(PAGE_CACHE_MAX_ENTRIES);
    expect(readPageCache("key-0", 2_000)).toBeNull();
    expect(readPageCache(`key-${PAGE_CACHE_MAX_ENTRIES + 4}`, 2_000)).toBe(PAGE_CACHE_MAX_ENTRIES + 4);
  });
});
