import { describe, expect, it } from "vitest";
import { mapJobTechHit } from "../../../packages/arbetsformedlingen/src/provider";
import { isHostOrSubdomain } from "../../../packages/core/src/url";
import {
  containsExactJobId,
  normalizeStudentConsultingJobUrl,
  normalizeStudentConsultingUrl,
  parseStudentConsultingJobText,
} from "../../../packages/studentconsulting/src/provider";

describe("trusted URL validation", () => {
  it("accepts exact domains and real subdomains but rejects lookalikes", () => {
    expect(isHostOrSubdomain("studentconsulting.com", "studentconsulting.com")).toBe(true);
    expect(isHostOrSubdomain("id.studentconsulting.com", "studentconsulting.com")).toBe(true);
    expect(isHostOrSubdomain("evilstudentconsulting.com", "studentconsulting.com")).toBe(false);
    expect(isHostOrSubdomain("studentconsulting.com.evil.test", "studentconsulting.com")).toBe(false);
  });

  it("canonicalizes StudentConsulting URLs onto the trusted origin", () => {
    expect(
      normalizeStudentConsultingUrl(
        "https://www.studentconsulting.com/sv/lediga-jobb/?page=2",
      ),
    ).toBe("https://www.studentconsulting.com/sv/lediga-jobb/?page=2");

    expect(
      normalizeStudentConsultingUrl(
        "https://id.studentconsulting.com/sv/lediga-jobb/?page=2",
      ),
    ).toBe("https://www.studentconsulting.com/sv/lediga-jobb/?page=2");

    expect(
      normalizeStudentConsultingUrl(
        "https://studentconsulting.com.evil.test/sv/lediga-jobb/",
      ),
    ).toBeNull();
  });

  it("only accepts StudentConsulting job-detail paths", () => {
    expect(
      normalizeStudentConsultingJobUrl(
        "https://www.studentconsulting.com/sv/lediga-jobb/stockholm/supporttekniker/87178/",
      ),
    ).toBe(
      "https://www.studentconsulting.com/sv/lediga-jobb/stockholm/supporttekniker/87178/",
    );
    expect(
      normalizeStudentConsultingJobUrl(
        "https://www.studentconsulting.com/sv/lediga-jobb/",
      ),
    ).toBeNull();
    expect(
      normalizeStudentConsultingJobUrl(
        "https://evil.test/sv/lediga-jobb/stockholm/supporttekniker/87178/",
      ),
    ).toBeNull();
  });
});

describe("StudentConsulting parsing", () => {
  it("extracts job id, location and occupation from the facts section", () => {
    const parsed = parseStudentConsultingJobText(`
      Annonsinnehåll
      Fakta om jobbet
      Jobb-ID 87178
      Antal platser 2 st
      Ort
      Malmö
      Yrkeskategori
      Industri / Produktion
    `);

    expect(parsed).toEqual({
      externalId: "87178",
      location: "Malmö",
      occupation: "Industri / Produktion",
    });
  });

  it("matches only the exact Jobb-ID during application verification", () => {
    expect(containsExactJobId("Jobb-ID 87178 Supporttekniker", "87178")).toBe(true);
    expect(containsExactJobId("Jobb-ID 187178 Supporttekniker", "87178")).toBe(false);
    expect(containsExactJobId("Butiksmedarbetare", "87178")).toBe(false);
  });
});

describe("JobTech mapping", () => {
  it("normalizes Swedish ads", () => {
    const mapped = mapJobTechHit({
      id: "123",
      headline: "Supporttekniker",
      webpage_url: "https://example.test/123",
      employer: { name: "Exempel AB" },
      workplace_address: {
        municipality: "Stockholm",
        country: "Sverige",
        country_code: "199",
      },
      occupation: { concept_id: "abc", label: "Supporttekniker" },
      application_details: {
        url: "https://example.test/apply",
        reference: "REF-123",
      },
    });

    expect(mapped).toMatchObject({
      provider: "arbetsformedlingen",
      externalId: "123",
      employer: "Exempel AB",
      location: "Stockholm",
      countryCode: "SE",
      isInternational: false,
      occupationConceptId: "abc",
      applicationReference: "REF-123",
    });
  });

  it("marks non-Swedish ads as international", () => {
    const mapped = mapJobTechHit({
      id: "456",
      headline: "Lagerarbeider",
      workplace_address: {
        municipality: "Oslo",
        country: "Norge",
        country_code: "NO",
      },
    });

    expect(mapped).toMatchObject({
      country: "Norge",
      countryCode: "NO",
      isInternational: true,
    });
  });
});