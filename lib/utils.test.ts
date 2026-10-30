import { describe, it, expect } from "vitest";
import { decodeEntities, sanitizeText, itemsSchema, parseItems, isValidVideoId } from "./utils";

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

describe("sanitizeText", () => {
  it("keeps text plain (React escapes on render) and cleans text older versions stored escaped", () => {
    expect(sanitizeText("Don't & <Stop>", 200)).toBe("Don't & <Stop>");
    expect(sanitizeText("Don&amp;#39;t", 200)).toBe("Don't");
    expect(sanitizeText("  " + "a".repeat(300), 200)).toBe("a".repeat(200));
  });
});

describe("itemsSchema / parseItems (structured outputs)", () => {
  it("closes both the root and each item to extra properties, as structured outputs requires", () => {
    const { schema } = itemsSchema({ properties: { v: { type: "string" } }, required: ["v"] });
    expect(schema.additionalProperties).toBe(false);
    expect(schema.properties.items.items.additionalProperties).toBe(false);
    expect(schema.required).toEqual(["items"]);
  });

  it("returns the items array, or [] when it is missing", () => {
    expect(parseItems('{"items":[1]}')).toEqual([1]);
    expect(parseItems("{}")).toEqual([]);
  });
});

describe("isValidVideoId", () => {
  it("accepts real 11-character YouTube ids only", () => {
    for (const ok of ["dQw4w9WgXcQ", "_sQSXwdtxlY", "vsBf_0gDxSM", "a-b_c-d_e-f"]) expect(isValidVideoId(ok)).toBe(true);
    for (const bad of ["", "v1", "dQw4w9WgXcQ_0", "dQw4w9WgXc\"", "abc def ghi", "<script>xyz", 12345678901, null, undefined])
      expect(isValidVideoId(bad)).toBe(false);
  });
});
