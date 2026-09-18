import { describe, expect, it } from "vitest";
import { chooseOccupationCandidate } from "./occupation";

describe("occupation resolution", () => {
  it("prefers one exact normalized label", () => {
    expect(
      chooseOccupationCandidate("IT-supporttekniker", [
        { id: "1", label: "IT-supporttekniker" },
        { id: "2", label: "Supporttekniker, övrig" },
      ]),
    ).toEqual({ id: "1", label: "IT-supporttekniker" });
  });

  it("accepts a clearly stronger token match", () => {
    expect(
      chooseOccupationCandidate("supporttekniker IT", [
        { id: "1", label: "IT supporttekniker" },
        { id: "2", label: "Kundtjänstmedarbetare" },
      ]),
    ).toEqual({ id: "1", label: "IT supporttekniker" });
  });

  it("fails closed when candidates are ambiguous", () => {
    expect(
      chooseOccupationCandidate("support tekniker", [
        { id: "1", label: "Support tekniker IT" },
        { id: "2", label: "Support tekniker telefoni" },
      ]),
    ).toBeNull();
  });
});
