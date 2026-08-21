import { describe, it } from "node:test";
import { expect } from "expect";

import { each, title } from "./each.js";

describe("each", () => {
  const seen: unknown[][] = [];
  each([
    ["a label", 1],
    ["another", 2]
  ])("spreads a tuple case across the callback: %s", (...args) => {
    seen.push(args);
  });

  it("gives each case its own arguments", () => {
    expect(seen).toEqual([
      ["a label", 1],
      ["another", 2]
    ]);
  });

  const scalars: unknown[][] = [];
  each(["one", "two"])("passes a scalar case as the single argument: %s", (...args) => {
    scalars.push(args);
  });

  it("does not spread a case that is not an array", () => {
    expect(scalars).toEqual([["one"], ["two"]]);
  });

  const typed: string[] = [];
  each([
    ["upper", (s: string) => s.toUpperCase()],
    ["lower", (s: string) => s.toLowerCase()]
  ])("infers the case's element types: %s", (label, transform) => {
    typed.push(`${label}:${transform("Ab")}`);
  });

  it("keeps the callback's parameters typed", () => {
    expect(typed).toEqual(["upper:AB", "lower:ab"]);
  });

  let skipped = false;
  each([["a case"]])(
    "passes node:test options through: %s",
    () => {
      skipped = true;
    },
    { skip: true }
  );

  it("did not run the skipped case", () => {
    expect(skipped).toBe(false);
  });
});

describe("a generated title", () => {
  // The reason this is a unit rather than an observation about registered
  // tests: `node:util`'s `format` appends arguments a name has no placeholder
  // for, and the commonest shape in this suite is a two-element case whose
  // name mentions only the first.
  it("consumes only as many arguments as it has placeholders", () => {
    expect(title("refuses %s", ["dot-dot", ".."])).toBe("refuses dot-dot");
  });

  it("treats %% as an escape rather than a placeholder", () => {
    expect(title("takes 100%% of %s", ["it"])).toBe("takes 100% of it");
  });

  it("renders %j as JSON and %i as an integer", () => {
    expect(title("refuses %j", [{ a: 1 }])).toBe('refuses {"a":1}');
    expect(title("refuses a %i", [301])).toBe("refuses a 301");
  });

  it("leaves a name with no placeholders alone", () => {
    expect(title("still quotes a bare AND", ["AND"])).toBe("still quotes a bare AND");
  });
});
