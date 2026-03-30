export default async function handler(req, res) {

const { cancerType, state } = req.query;

const url = `https://clinicaltrials.gov/api/query/study_fields?expr=${encodeURIComponent(cancerType)}&fields=NCTId,BriefTitle,Condition,Phase,OverallStatus,LocationState&min_rnk=1&max_rnk=50&fmt=json`;

const response = await fetch(url);
const data = await response.json();

const studies = data.StudyFieldsResponse.StudyFields.map(s => ({
title: s.BriefTitle[0],
nct: s.NCTId[0],
phase: s.Phase[0] || "N/A",
condition: s.Condition[0] || "N/A",
status: s.OverallStatus[0],
states: s.LocationState || [],
url: `https://clinicaltrials.gov/study/${s.NCTId[0]}`
}));

const filtered = state
? studies.filter(s => s.states.includes(state))
: studies;

res.status(200).json({ studies: filtered });

}