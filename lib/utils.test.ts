import { describe, it, expect } from "vitest";
import { decodeEntities, sanitizeText, itemsSchema, parseItems } from "./utils";

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
