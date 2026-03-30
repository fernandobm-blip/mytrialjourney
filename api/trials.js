export default async function handler(req, res) {
  if (req.method !== "GET") {
    return res.status(405).json({ error: "Method not allowed" });
  }

  try {
    const { cancerType = "", state = "", biomarkers = "[]", treatments = "[]" } = req.query;

    if (!cancerType.trim()) {
      return res.status(400).json({ error: "Missing cancerType" });
    }

    const biomarkerList = parseJsonArray(biomarkers);
    const treatmentList = parseJsonArray(treatments);

    const searchTerms = [
      cancerType,
      ...biomarkerList,
      ...treatmentList
    ]
      .map((x) => String(x || "").trim())
      .filter(Boolean);

    const queryTerm = searchTerms
      .map((term) => /\s/.test(term) ? `"${term}"` : term)
      .join(" AND ");

    const url = new URL("https://clinicaltrials.gov/api/v2/studies");
    url.searchParams.set("query.term", queryTerm);
    url.searchParams.set("pageSize", "100");
    url.searchParams.set("countTotal", "true");
    url.searchParams.set("format", "json");

    const response = await fetch(url.toString(), {
      method: "GET",
      headers: {
        accept: "application/json"
      }
    });

    if (!response.ok) {
      const text = await safeText(response);
      return res.status(502).json({
        error: "ClinicalTrials.gov request failed",
        status: response.status,
        details: text || "Upstream request failed"
      });
    }

    const data = await response.json();
    const studies = Array.isArray(data?.studies) ? data.studies : [];

    const normalized = studies.map(normalizeStudy);

    const filtered = state
      ? normalized.filter((study) =>
          study.states.some((s) => sameText(s, state))
        )
      : normalized;

    return res.status(200).json({
      studies: filtered,
      meta: {
        returned: filtered.length,
        totalFromApi: normalized.length,
        query: queryTerm
      }
    });
  } catch (error) {
    return res.status(500).json({
      error: "Internal server error",
      details: error?.message || "Unknown error"
    });
  }
}

function parseJsonArray(value) {
  try {
    const parsed = JSON.parse(value);
    return Array.isArray(parsed) ? parsed : [];
  } catch {
    return [];
  }
}

function sameText(a, b) {
  return String(a || "").trim().toLowerCase() === String(b || "").trim().toLowerCase();
}

function firstText(arr, fallback = "N/A") {
  if (!Array.isArray(arr)) return fallback;
  const found = arr.find((x) => String(x || "").trim());
  return found ? String(found).trim() : fallback;
}

function normalizeStudy(study) {
  const protocol = study?.protocolSection || {};

  const identification = protocol?.identificationModule || {};
  const status = protocol?.statusModule || {};
  const conditions = protocol?.conditionsModule || {};
  const design = protocol?.designModule || {};
  const description = protocol?.descriptionModule || {};
  const sponsors = protocol?.sponsorCollaboratorsModule || {};
  const contactsLocations = protocol?.contactsLocationsModule || {};

  const locations = Array.isArray(contactsLocations?.locations)
    ? contactsLocations.locations
    : [];

  const normalizedLocations = locations.map((loc) => {
    const facility =
      loc?.facility ||
      loc?.facilityName ||
      "Study site";

    const city =
      loc?.city ||
      loc?.facility?.address?.city ||
      "";

    const state =
      loc?.state ||
      loc?.facility?.address?.state ||
      "";

    const country =
      loc?.country ||
      loc?.facility?.address?.country ||
      "";

    return {
      facility: String(facility || "Study site").trim(),
      city: String(city || "").trim(),
      state: String(state || "").trim(),
      country: String(country || "").trim()
    };
  });

  const states = [...new Set(normalizedLocations.map((x) => x.state).filter(Boolean))];

  return {
    title: identification?.briefTitle || "Untitled study",
    nct: identification?.nctId || "N/A",
    phase: firstText(design?.phases, "N/A"),
    condition: firstText(conditions?.conditions, "N/A"),
    status: status?.overallStatus || "N/A",
    sponsor: sponsors?.leadSponsor?.name || "N/A",
    summary:
      description?.briefSummary ||
      description?.detailedDescription ||
      "This study record is available on ClinicalTrials.gov.",
    states,
    locations: normalizedLocations,
    url: identification?.nctId
      ? `https://clinicaltrials.gov/study/${identification.nctId}`
      : "#"
  };
}

async function safeText(response) {
  try {
    return await response.text();
  } catch {
    return "";
  }
}
