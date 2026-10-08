import { describe, expect, it } from "vitest";
import { ServerUnreachableError, resolveServerUrl, serverUrlCandidates } from "../src/serverUrl";

const info = () => new Response(JSON.stringify({ name: "Nexus", version: "0.2.4" }), { status: 200 });

describe("serverUrlCandidates", () => {
  it("keeps an explicit scheme", () => {
    expect(serverUrlCandidates(" http://1.2.3.4:30001/ ")).toEqual(["http://1.2.3.4:30001"]);
    expect(serverUrlCandidates("https://nexus.exemplo.com")).toEqual(["https://nexus.exemplo.com"]);
  });

  it("tries https then http without one", () => {
    expect(serverUrlCandidates("1.2.3.4:30001")).toEqual(["https://1.2.3.4:30001", "http://1.2.3.4:30001"]);
  });

  it("is empty for blank input", () => {
    expect(serverUrlCandidates("  ")).toEqual([]);
  });
});

describe("resolveServerUrl", () => {
  it("falls back to http when https does not answer", async () => {
    const seen: string[] = [];
    const fake = (async (url: string) => {
      seen.push(url);
      if (url.startsWith("https://")) throw new TypeError("Network request failed");
      return info();
    }) as unknown as typeof fetch;
    await expect(resolveServerUrl("1.2.3.4:30001", fake)).resolves.toBe("http://1.2.3.4:30001");
    expect(seen).toEqual(["https://1.2.3.4:30001/api/info", "http://1.2.3.4:30001/api/info"]);
  });

  it("prefers https when it works", async () => {
    const fake = (async () => info()) as unknown as typeof fetch;
    await expect(resolveServerUrl("nexus.exemplo.com", fake)).resolves.toBe("https://nexus.exemplo.com");
  });

  it("ignores something that is not a Nexus server", async () => {
    const fake = (async () => new Response("<html>", { status: 200 })) as unknown as typeof fetch;
    await expect(resolveServerUrl("http://1.2.3.4", fake)).rejects.toBeInstanceOf(ServerUnreachableError);
  });

  it("says which addresses it tried", async () => {
    const fake = (async () => {
      throw new TypeError("fail");
    }) as unknown as typeof fetch;
    await expect(resolveServerUrl("1.2.3.4:30001", fake)).rejects.toThrow(
      "Não foi possível conectar a https://1.2.3.4:30001 nem a http://1.2.3.4:30001.",
    );
  });
});
