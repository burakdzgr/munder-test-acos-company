// NATS subject builders — co.<companyId>.<eventType> (_DECISIONS §21).
export const SUBJECT_PREFIX = "co." as const;

export function subjectFor(companyId: string, eventType: string): string {
  return `${SUBJECT_PREFIX}${companyId}.${eventType}`;
}

/** Wildcard subject covering every event of one company. */
export function companySubjectWildcard(companyId: string): string {
  return `${SUBJECT_PREFIX}${companyId}.>`;
}

export function parseSubject(subject: string): { companyId: string; eventType: string } | null {
  if (!subject.startsWith(SUBJECT_PREFIX)) return null;
  const rest = subject.slice(SUBJECT_PREFIX.length);
  const dot = rest.indexOf(".");
  if (dot <= 0 || dot === rest.length - 1) return null;
  return { companyId: rest.slice(0, dot), eventType: rest.slice(dot + 1) };
}
