import { describe, it, expect } from "vitest";
import { decodeEntities, sanitizeText } from "./utils";

describe("decodeEntities", () => {
  it("inverts sanitizeText, even when escaped twice", () => {
    expect(decodeEntities(sanitizeText("Don't & <Stop>"))).toBe("Don't & <Stop>");
    expect(decodeEntities("Don&amp;#39;t")).toBe("Don't");
  });
  it("leaves plain text and unknown entities alone", () => {
    expect(decodeEntities("五月天 Mayday")).toBe("五月天 Mayday");
    expect(decodeEntities("&nbsp;&copy;")).toBe("&nbsp;&copy;");
  });
});

describe("sanitizeText truncation (/ship adversarial #8)", () => {
  it("never leaves half an entity at the cut", () => {
    const out = sanitizeText("a".repeat(197) + "&b", 200); // escaped "&amp;" straddles the 200 cut
    expect(out).toBe("a".repeat(197));
    expect(decodeEntities(sanitizeText("Tom & Jerry", 200))).toBe("Tom & Jerry");
  });
});
