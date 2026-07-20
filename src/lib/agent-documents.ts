// The document set an admin uploads against a selling agent's profile.
// Requirement (requirements_for_sales_agent.docx, task 3): registration
// form, cheque leaf, passport-size photo, NID — plus the nominee's photo
// and NID. All uploaded from the admin panel, never by the agent.
//
// `type` is stored on AgentDocument as a plain string; this file is the
// single source of truth for which values are legal and how they render.

export const AGENT_DOC_TYPES = [
  "REGISTRATION_FORM",
  "CHEQUE_LEAF",
  "PHOTO",
  "NID_FRONT",
  "NID_BACK",
  "NOMINEE_PHOTO",
  "NOMINEE_NID_FRONT",
  "NOMINEE_NID_BACK",
] as const;

export type AgentDocType = (typeof AGENT_DOC_TYPES)[number];

const TYPE_SET: ReadonlySet<string> = new Set(AGENT_DOC_TYPES);

export function isAgentDocType(value: string): value is AgentDocType {
  return TYPE_SET.has(value);
}

export const AGENT_DOC_LABELS: Record<AgentDocType, string> = {
  REGISTRATION_FORM: "Registration form",
  CHEQUE_LEAF: "Cheque leaf",
  PHOTO: "Photograph (passport size)",
  NID_FRONT: "NID — front",
  NID_BACK: "NID — back",
  NOMINEE_PHOTO: "Nominee photograph",
  NOMINEE_NID_FRONT: "Nominee NID — front",
  NOMINEE_NID_BACK: "Nominee NID — back",
};

// Rendering order + grouping for the admin upload panel and the agent's
// read-only view.
export const AGENT_DOC_GROUPS: ReadonlyArray<{
  title: string;
  types: ReadonlyArray<AgentDocType>;
}> = [
  { title: "Agent", types: ["REGISTRATION_FORM", "PHOTO", "NID_FRONT", "NID_BACK", "CHEQUE_LEAF"] },
  { title: "Nominee", types: ["NOMINEE_PHOTO", "NOMINEE_NID_FRONT", "NOMINEE_NID_BACK"] },
];

// A photograph is a photograph — a PDF there is always a mistake, and
// allowing it would let a scanned multi-page document masquerade as an
// ID photo. Scans and the signed registration form legitimately arrive
// as PDFs.
export const AGENT_PDF_ALLOWED: ReadonlySet<string> = new Set<AgentDocType>([
  "REGISTRATION_FORM",
  "CHEQUE_LEAF",
  "NID_FRONT",
  "NID_BACK",
  "NOMINEE_NID_FRONT",
  "NOMINEE_NID_BACK",
]);
