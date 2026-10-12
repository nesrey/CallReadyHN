import type { CallType } from "../scenarios/load.js";

/** One line of the QA scorecard. Weights in a rubric add up to 100; each criterion is scored 0-10. */
export interface Criterion {
  key: string;
  label: string;
  weight: number;
  /** What the grader checks. */
  description: string;
}

export const CUSTOMER_RUBRIC: readonly Criterion[] = [
  { key: "opening", label: "Opening", weight: 10, description: "Greets the caller, gives their name and the company, offers help." },
  { key: "verification", label: "Verification", weight: 10, description: "Verifies identity as the policy requires before discussing the account; required disclosures read when the policy asks for them." },
  { key: "listening", label: "Active listening", weight: 10, description: "Acknowledges and restates the issue, asks clarifying questions, does not make the caller repeat information." },
  { key: "empathy", label: "Empathy & tone", weight: 15, description: "Acknowledges feelings and impact sincerely and specifically; calm, warm tone; does not over-apologize or sound scripted." },
  { key: "control", label: "Call control", weight: 15, description: "Guides the conversation, handles interruptions and objections, sets expectations, keeps the call moving." },
  { key: "resolution", label: "Resolution", weight: 20, description: "Solves the problem correctly using the account details and the policies; offers what the policy allows; never promises what it does not; gives reference numbers and timelines." },
  { key: "language", label: "Professional language", weight: 10, description: "Clear, concise, positive phrasing; no slang, filler or blaming language; grammar mistakes only count when they sound unprofessional or confuse." },
  { key: "closing", label: "Closing", weight: 10, description: "Summarizes what was done and the next steps, asks if there is anything else, closes politely." },
];

export const INTERVIEW_RUBRIC: readonly Criterion[] = [
  { key: "introduction", label: "Introduction", weight: 10, description: "Greets the interviewer, gives their name and the position." },
  { key: "clarity", label: "Clarity", weight: 15, description: "Clear, well-organized answers of a sensible length." },
  { key: "experience", label: "Relevant experience", weight: 20, description: "Connects experience and skills to customer support with specific examples." },
  { key: "situational", label: "Situational answer", weight: 25, description: "Handles the situational question with a concrete approach: empathy, policy, options, follow-up." },
  { key: "professionalism", label: "Professionalism", weight: 15, description: "Positive, confident, polite; avoids slang and negative talk about past employers." },
  { key: "closing", label: "Questions & closing", weight: 15, description: "Asks at least one thoughtful question about the job, thanks the interviewer, confirms next steps." },
];

export function rubricFor(callType: CallType): readonly Criterion[] {
  return callType === "interview" ? INTERVIEW_RUBRIC : CUSTOMER_RUBRIC;
}

/** 0-100 from 0-10 criterion scores. Computed here, never by the model. */
export function qaScore(scores: Record<string, number>, rubric: readonly Criterion[]): number {
  const total = rubric.reduce((sum, c) => sum + c.weight * (scores[c.key] ?? 0), 0);
  return Math.round(total / 10);
}
