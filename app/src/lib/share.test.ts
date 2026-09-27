import { describe, expect, it } from "vitest";
import { shareContent, shareWithCapacitor, type NativeShareOptions } from "./share";

function pdf(): File {
  return new File(["%PDF-1.4"], "lasku.pdf", { type: "application/pdf" });
}

describe("shareWithCapacitor", () => {
  it("passes the file uri so the PDF bytes are attached", async () => {
    const calls: NativeShareOptions[] = [];
    const result = await shareWithCapacitor(
      { title: "Lasku 12", text: "Lasku 12", url: "https://example.test/laskut/12", file: pdf() },
      {
        isNativePlatform: () => true,
        fileUri: async () => "file:///cache/lasku.pdf",
        share: async (options) => {
          calls.push(options);
        },
      }
    );
    expect(result).toBe("shared");
    expect(calls).toEqual([
      {
        title: "Lasku 12",
        text: "Lasku 12",
        files: ["file:///cache/lasku.pdf"],
        dialogTitle: "Lasku 12",
      },
    ]);
  });

  it("does not report success when the file cannot be attached", async () => {
    let called = false;
    const result = await shareWithCapacitor(
      { title: "Lasku", url: "https://example.test", file: pdf() },
      {
        isNativePlatform: () => true,
        fileUri: async () => null,
        share: async () => {
          called = true;
        },
      }
    );
    expect(called).toBe(false);
    expect(result).toBeNull();
  });
});

describe("shareContent web fallback", () => {
  it("downloads instead of claiming a url-only share when a file was required", async () => {
    let webCalls = 0;
    let downloaded = false;
    const result = await shareContent(
      { title: "Lasku", text: "hei", url: "https://example.test/lasku", file: pdf() },
      {
        isNativePlatform: () => false,
        canShareFiles: () => false,
        webShare: async () => {
          webCalls += 1;
        },
        download: () => {
          downloaded = true;
          return true;
        },
      }
    );
    expect(webCalls).toBe(0);
    expect(downloaded).toBe(true);
    expect(result).toBe("downloaded");
  });

  it("still shares text when no file was required", async () => {
    const shared: ShareData[] = [];
    const result = await shareContent(
      { title: "Muistutus", text: "Erääntynyt lasku", url: "https://example.test" },
      {
        isNativePlatform: () => false,
        canShareFiles: () => false,
        webShare: async (data) => {
          shared.push(data);
        },
        download: () => false,
      }
    );
    expect(result).toBe("shared");
    expect(shared[0]?.url).toBe("https://example.test");
    expect(shared[0]?.files).toBeUndefined();
  });

  it("reports a dismissed share sheet as cancelled and does not download", async () => {
    let downloaded = false;
    const result = await shareContent(
      { title: "Lasku", file: pdf() },
      {
        isNativePlatform: () => true,
        canShareFiles: () => false,
        fileUri: async () => "file:///cache/lasku.pdf",
        share: async () => {
          throw new DOMException("Share canceled", "AbortError");
        },
        webShare: async () => {
          throw new Error("web share should not run after a native cancel");
        },
        download: () => {
          downloaded = true;
          return true;
        },
      }
    );
    expect(result).toBe("cancelled");
    expect(downloaded).toBe(false);
  });

  it("does not claim a download that never happened", async () => {
    const result = await shareContent(
      { title: "Lasku", file: pdf() },
      {
        isNativePlatform: () => false,
        canShareFiles: () => false,
        webShare: async () => {
          throw new Error("should not share without the file");
        },
        download: () => false,
      }
    );
    expect(result).toBe("unavailable");
  });
});
