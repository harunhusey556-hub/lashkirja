import { describe, expect, it } from "vitest";
import { rowFromFile, validateUploadFile } from "./useReceiptUploadQueue";

describe("rowFromFile", () => {
  it("keeps every file of a 240-file pick, invalid ones failed with their message", () => {
    const files = Array.from({ length: 240 }, (_, index) =>
      new File([Uint8Array.from([0xff, 0xd8, 0xff, index % 256, 0xd9])], `kuitti-${index}.jpg`, {
        type: "image/jpeg",
      })
    );
    // One empty, one over the size limit, one unsupported type.
    files[10] = new File([], "tyhja.jpg", { type: "image/jpeg" });
    files[11] = new File([new Uint8Array(16 * 1024 * 1024)], "iso.jpg", { type: "image/jpeg" });
    files[12] = new File([new Uint8Array(4)], "aineisto.txt", { type: "text/plain" });

    const rows = files.map((file, index) => rowFromFile(file, `r${index}`));
    expect(rows).toHaveLength(240);
    expect(rows.filter((row) => row.status === "pending")).toHaveLength(237);
    const failed = rows.filter((row) => row.status === "failed");
    expect(failed.map((row) => row.error)).toEqual([
      "Tiedosto on tyhjä",
      "Tiedosto on liian suuri (enintään 15 Mt)",
      "Tuemme PDF-, JPG-, PNG- ja HEIC-tiedostoja",
    ]);
  });

  it("validates a file the same way enqueue sees it", () => {
    expect(validateUploadFile(new File([new Uint8Array(1)], "kuitti.jpg", { type: "image/jpeg" }))).toBeNull();
    expect(validateUploadFile(new File([], "kuitti.png", { type: "image/png" }))).toBe(
      "Tiedosto on tyhjä"
    );
    expect(
      validateUploadFile(new File([new Uint8Array(1)], "kuitti.avi", { type: "video/x-msvideo" }))
    ).toBe("Tuemme PDF-, JPG-, PNG- ja HEIC-tiedostoja");
  });
});
