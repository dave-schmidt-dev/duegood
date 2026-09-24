import { readFileSync } from "node:fs";
import path from "node:path";
import { describe, expect, it } from "vitest";
import {
  REQUIRED_SECTIONS,
  extractSection,
  parseContractTableRows,
  validateContractDoc,
  validateFixtureDoc,
  validateFixtureOrigins,
  validateFixtureSynthetic,
  validateRequiredSections,
  validateSectionStatuses,
} from "../../scripts/check-refresh-contract.mjs";

const ROOT = path.resolve(__dirname, "..", "..");

function sectionTable(heading: string, rows: string[]): string {
  const body = rows.map((row, index) => `| ${index + 1} | Row ${index + 1} text. | ${row} |`).join("\n");
  return `${heading}\n\n| # | Contract row | Status |\n|---|---|---|\n${body}\n`;
}

const PASSING_DOC = REQUIRED_SECTIONS.map((heading) =>
  sectionTable(heading, ["confirmed", "unknown — could not be resolved without private data.", "intentionally changed — Decision 7 changes this."]),
).join("\n");

describe("validateRequiredSections", () => {
  it("passes when all six sections are present", () => {
    expect(validateRequiredSections(PASSING_DOC)).toEqual([]);
  });

  it("fails when a required section is missing", () => {
    const doc = PASSING_DOC.replace("## Broker\n", "## Not Broker\n");
    const errors = validateRequiredSections(doc);
    expect(errors).toHaveLength(1);
    expect(errors[0]).toMatch(/missing the required section "## Broker"/);
  });
});

describe("validateSectionStatuses", () => {
  it("passes a well-formed table in every section", () => {
    expect(validateSectionStatuses(PASSING_DOC)).toEqual([]);
  });

  it("fails a row with an invalid status value", () => {
    const doc = PASSING_DOC.replace("| 1 | Row 1 text. | confirmed |", "| 1 | Row 1 text. | maybe |");
    const errors = validateSectionStatuses(doc);
    expect(errors.some((error) => error.includes('does not start with confirmed/unknown/intentionally changed'))).toBe(true);
  });

  it("fails an 'unknown' status with no reason given", () => {
    const doc = PASSING_DOC.replace(
      "| 2 | Row 2 text. | unknown — could not be resolved without private data. |",
      "| 2 | Row 2 text. | unknown |",
    );
    const errors = validateSectionStatuses(doc);
    expect(errors.some((error) => error.includes("has no reason after it"))).toBe(true);
  });

  it("fails an 'intentionally changed' status with no reason given", () => {
    const doc = PASSING_DOC.replace(
      "| 3 | Row 3 text. | intentionally changed — Decision 7 changes this. |",
      "| 3 | Row 3 text. | intentionally changed |",
    );
    const errors = validateSectionStatuses(doc);
    expect(errors.some((error) => error.includes("has no reason after it"))).toBe(true);
  });

  it("fails a section whose table has no data rows", () => {
    const doc = PASSING_DOC.replace(
      /\| 1 \| Row 1 text\. \| confirmed \|\n\| 2 \| Row 2 text\. \| unknown .*\|\n\| 3 \| Row 3 text\. \| intentionally changed .*\|\n/,
      "",
    );
    const errors = validateSectionStatuses(doc);
    expect(errors.some((error) => error.includes("has no contract table rows"))).toBe(true);
  });
});

describe("parseContractTableRows / extractSection", () => {
  it("extracts a section up to the next ## heading", () => {
    const section = extractSection(PASSING_DOC, "## Course import");
    expect(section).toBeDefined();
    expect(section).toMatch(/Row 1 text\./);
    expect(section).not.toMatch(/canvas-export and materials/);
  });

  it("parses only numbered data rows, skipping header and separator", () => {
    const section = extractSection(PASSING_DOC, "## Course import")!;
    const rows = parseContractTableRows(section);
    expect(rows).toHaveLength(3);
    expect(rows[0]!.cells).toEqual(["1", "Row 1 text.", "confirmed"]);
  });
});

describe("validateFixtureSynthetic / validateFixtureOrigins", () => {
  it("fails a fixture not marked synthetic:true", () => {
    expect(validateFixtureSynthetic({ synthetic: false }, "fixture.json")).toEqual(["fixture.json is not marked \"synthetic\": true."]);
    expect(validateFixtureSynthetic({}, "fixture.json")).toEqual(["fixture.json is not marked \"synthetic\": true."]);
  });

  it("passes a fixture marked synthetic:true with only .invalid origins", () => {
    const fixture = { synthetic: true, url: "https://canvas.example.invalid/api/v1/courses/1" };
    expect(validateFixtureSynthetic(fixture, "fixture.json")).toEqual([]);
    expect(validateFixtureOrigins(fixture, "fixture.json")).toEqual([]);
  });

  it("fails a fixture using a non-.invalid origin, including one nested in prose", () => {
    const fixture = { synthetic: true, note: "See https://canvas.instructure.com/courses/1 for the real one." };
    const errors = validateFixtureOrigins(fixture, "fixture.json");
    expect(errors).toHaveLength(1);
    expect(errors[0]).toMatch(/non-\.invalid origin/);
  });

  it("validateFixtureDoc combines both checks", () => {
    const fixture = { synthetic: false, url: "https://real.example.com/x" };
    const errors = validateFixtureDoc(fixture, "fixture.json");
    expect(errors).toHaveLength(2);
  });
});

describe("the repository's real refresh contract and fixtures", () => {
  it("pass the refresh contract check", () => {
    const contractDoc = readFileSync(path.join(ROOT, "docs", "REFRESH-CONTRACT.md"), "utf8");
    const mockFixture = JSON.parse(readFileSync(path.join(ROOT, "test", "fixtures", "refresh-canvas-mock.json"), "utf8"));
    const expectedStoreFixture = JSON.parse(readFileSync(path.join(ROOT, "test", "fixtures", "refresh-expected-store.json"), "utf8"));
    const acquisitionFixture = JSON.parse(readFileSync(path.join(ROOT, "test", "fixtures", "ical-acquisition-contract.json"), "utf8"));

    expect(validateContractDoc(contractDoc)).toEqual([]);
    expect(validateFixtureDoc(mockFixture, "test/fixtures/refresh-canvas-mock.json")).toEqual([]);
    expect(validateFixtureDoc(expectedStoreFixture, "test/fixtures/refresh-expected-store.json")).toEqual([]);
    expect(validateFixtureDoc(acquisitionFixture, "test/fixtures/ical-acquisition-contract.json")).toEqual([]);
  });
});
