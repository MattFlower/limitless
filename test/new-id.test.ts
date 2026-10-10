import { expect, spyOn, test } from "bun:test";
import { newId } from "../src/db/store.ts";

test("100,000 ids created in one millisecond are unique and valid run ids", () => {
  const time = spyOn(Date, "now").mockReturnValue(123456);
  try {
    const ids = Array.from({ length: 100_000 }, () => newId());
    expect(new Set(ids).size).toBe(100_000);
    expect(ids.every((id) => /^[0-9a-z]{1,32}$/.test(id))).toBe(true);
    expect(ids.every((id) => id.startsWith("2n9c"))).toBe(true);
  } finally {
    time.mockRestore();
  }
});
