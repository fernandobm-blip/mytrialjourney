export default async function handler(req, res) {
  if (req.method && req.method !== "GET") {
    return res.status(405).json({ error: "Method not allowed" });
  }

  try {
    const { cancerType = "", state = "", biomarkers, treatments } = req.query;

    const biomarkerList = parseListParam(biomarkers);
    const treatmentList = parseListParam(treatments);

    const searchTerms = [
      cleanTerm(cancerType),
      ...biomarkerList.map(cleanTerm),
      ...treatmentList.map(cleanTerm),
    ].filter(Boolean);

    if (!searchTerms.length) {
      return res.status(400).json({
        error: "Missing search criteria",
        details: "Provide at least cancerType or another filter."
      });
    }

    const searchExpression = searchTerms.map(quoteIfNeeded).join(" AND ");

    const url = new URL("https://clinicaltrials.gov/api/query/studies");
    url.searchParams.set("format", "json");
    url.searchParams.set("pageSize", "100");
    url.searchParams.set("countTotal", "true");
    url.searchParams.set("query.term", searchExpression);

    const controller = new AbortController();
    const timeout = setTimeout(() => controller.abort(), 15000);

    let response;
    try {
      response = await fetch(url.toString(), {
        method: "GET",
        headers: { accept: "application/json" },
        signal: controller.signal
      });
    } finally {
      clearTimeout(timeout);
    }

    if (!response.ok) {
      const text = await safeReadText(response);
      console.error("ClinicalTrials.gov upstream error:", response.status, text);

      return res.status(502).json({
        error: "ClinicalTrials.gov request failed",
        status: response.status,
        details: text || "No response body returned from upstream service."
      });
    }

    const data = await response.json();
    const rawStudies = Array.isArray(data?.studies) ? data.studies : [];

    const normalized = rawStudies.map(normalizeStudy);

    const filteredByState = state
      ? normalized.filter((study) =>
          study.states.some((s) => equalsIgnoreCase(s, state))
        )
      : normalized;

    return res.status(200).json({
      studies: filteredByState,
      meta: {
        returned: filteredByState.length,
        sourceReturned: normalized.length,
        query: searchExpression
      }
    });
  } catch (error) {
    console.error("API /api/trials failed:", error);

    return res.status(500).json({
      error: "Internal server error",
      details: error?.message || "Unknown error"
    });
  }
}

function parseListParam(value) {
  if (!value) return [];

  if (Array.isArray(value)) {
    return value.flatMap((item) => parseListParam(item));
  }

  if (typeof value !== "string") {
    return [];
  }

  const trimmed = value.trim();
  if (!trimmed) return [];

  if (trimmed.startsWith("[") && trimmed.endsWith("]")) {
    try {
      const parsed = JSON.parse(trimmed);
      if (Array.isArray(parsed)) {
        return parsed.map(String).map((x) => x.trim()).filter(Boolean);
      }
    } catch {
      // continue
    }
  }

  if (trimmed.includes(",")) {
    return trimmed
      .split(",")
      .map((x) => x.trim())
      .filter(Boolean);
  }

  return [trimmed];
}

function cleanTerm(value) {
  return String(value || "").replace(/\s+/g, " ").trim();
}

function quoteIfNeeded(term) {
  return /\s/.test(term) ? `"${term}"` : term;
}

function equalsIgnoreCase(a, b) {
  return String(a || "").trim().toLowerCase() === String(b || "").trim().toLowerCase();
}

function firstNonEmpty(arr) {
  if (!Array.isArray(arr)) return "";
  const found = arr.find((x) => String(x || "").trim());
  return found ? String(found).trim() : "";
}

function safeArray(value) {
  return Array.isArray(value) ? value : [];
}

function normalizeStudy(study) {
  const protocol = study?.protocolSection || {};

  const identification = protocol?.identificationModule || {};
  const conditionsModule = protocol?.conditionsModule || {};
  const designModule = protocol?.designModule || {};
  const statusModule = protocol?.statusModule || {};
  const contactsLocationsModule = protocol?.contactsLocationsModule || {};
  const sponsorModule = protocol?.sponsorCollaboratorsModule || {};
  const descriptionModule = protocol?.descriptionModule || {};

  const nctId = identification?.nctId || "";
  const title = identification?.briefTitle || "Untitled study";

  const conditions = safeArray(conditionsModule?.conditions);
  const phases = safeArray(designModule?.phases);
  const locations = safeArray(contactsLocationsModule?.locations);

  const normalizedLocations = locations.map((loc) => {
    const facility =
      loc?.facility ||
      loc?.facilityName ||
      loc?.contacts?.[0]?.name ||
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

  const states = Array.from(
    new Set(normalizedLocations.map((x) => x.state).filter(Boolean))
  );

  const sponsor =
    sponsorModule?.leadSponsor?.name ||
    "N/A";

  const briefSummary =
    descriptionModule?.briefSummary ||
    descriptionModule?.detailedDescription ||
    "This study record is available on ClinicalTrials.gov. Discuss with your doctor whether it may be relevant for your situation.";

  return {
    title,
    nct: nctId || "N/A",
    phase: firstNonEmpty(phases) || "N/A",
    condition: firstNonEmpty(conditions) || "N/A",
    status: statusModule?.overallStatus || "N/A",
    sponsor,
    summary: String(briefSummary || "").trim(),
    states,
    locations: normalizedLocations,
    url: nctId ? `https://clinicaltrials.gov/study/${nctId}` : "#"
  };
}

async function safeReadText(response) {
  try {
    return await response.text();
  } catch {
    return "";
  }
}
