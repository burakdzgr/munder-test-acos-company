// Intake Report renderer (T42; 14 §3.2): the 16 canonical sections with
// FIXED headings — consumers depend on them. Deterministic template over the
// analyzer JSON (14 §3.1 stage 3's interpretive LLM pass lands with the live
// synthesis polish; recorded scope: deterministic synthesis keeps CI and the
// degraded path P6-safe — an unavailable analyzer never blocks the report).
// All repo-derived text is UNTRUSTED (P3): report consumers (working sets)
// wrap artifact content in provenance fences before prompting.

export interface ReportAnalyzerResult {
  analyzer: string;
  title: string;
  ok: boolean;
  findings: unknown;
  error: string | null;
}

/**
 * B4 (14 §3.1 stage 3) — the interpretive pass.
 *
 * The analyzers answer "what IS in this repo"; five sections of 14 §3.2 ask
 * "what does it MEAN", and those shipped hard-coded as `_analysis
 * unavailable_`. A Founder importing a project got a JSON dump under fifteen
 * headings and no reading of it. This is the model's reading, per section.
 *
 * Every field is optional and the renderer falls back to the deterministic
 * text: an unavailable model degrades the report, exactly like an unavailable
 * analyzer, and never blocks intake (P6).
 */
export interface ReportSynthesis {
  executiveSummary?: string | undefined;
  dataLayer?: string | undefined;
  apiSurface?: string | undefined;
  technicalDebt?: string | undefined;
  qualityMetrics?: string | undefined;
  productSignals?: string | undefined;
  recommendedPlan?: string | undefined;
  openQuestions?: string | undefined;
}

export interface ReportInput {
  projectName: string;
  objective: string;
  constraints: string | null;
  sourceRef: string | null;
  ingest: {
    defaultBranch: string;
    headCommit: string;
    branches: string[];
    sizeKb: number;
  };
  analyzers: ReportAnalyzerResult[];
  /** B4: model reading of the analyzer output; absent ⇒ deterministic text. */
  synthesis?: ReportSynthesis | undefined;
  /**
   * B4: a project with no repository at all (an idea, not an import). The
   * repo-derived sections say so plainly instead of pretending to be
   * "unavailable analysis", and the interpretive sections still carry weight
   * because they come from the objective.
   */
  greenfield?: boolean | undefined;
}

const UNAVAILABLE = "_analysis unavailable_";

function fence(value: unknown): string {
  return "```json\n" + JSON.stringify(value, null, 2).slice(0, 6000) + "\n```";
}

function section(results: ReportAnalyzerResult[], key: string): string {
  const hit = results.find((r) => r.analyzer === key);
  if (!hit) return UNAVAILABLE;
  if (!hit.ok) return `${UNAVAILABLE}\n\n> analyzer error: ${hit.error ?? "unknown"}`;
  return fence(hit.findings);
}

/** The 16 canonical headings of 14 §3.2, verbatim and in order. */
export const INTAKE_REPORT_SECTIONS = [
  "Executive summary",
  "Repository profile",
  "Technology stack",
  "Architecture assessment",
  "Dependency health",
  "Data layer",
  "API surface",
  "Test & CI status",
  "Configuration & environments",
  "Documentation state",
  "Security findings",
  "Technical debt register",
  "Quality metrics",
  "Product/market signals",
  "Recommended plan",
  "Open questions for the organization",
] as const;

/** Model reading when present, deterministic text otherwise (P6). */
function synth(input: ReportInput, key: keyof ReportSynthesis, fallback: string): string {
  const value = input.synthesis?.[key];
  return typeof value === "string" && value.trim().length > 0 ? value.trim() : fallback;
}

/** Repo sections on a greenfield project: honest, not "unavailable". */
const GREENFIELD = "_no repository yet — this project starts from the objective_";

export function buildIntakeReport(input: ReportInput): string {
  const ok = input.analyzers.filter((a) => a.ok).length;
  const failed = input.analyzers.length - ok;
  const repoSection = (key: string) =>
    input.greenfield ? GREENFIELD : section(input.analyzers, key);
  const languages = input.analyzers.find((a) => a.analyzer === "languages" && a.ok);
  const langLine = languages
    ? Object.entries(
        (languages.findings as { fileCountsByExtension?: Record<string, number> })
          .fileCountsByExtension ?? {},
      )
        .slice(0, 5)
        .map(([ext, n]) => `${ext} (${n})`)
        .join(", ")
    : "unknown stack";

  const deterministicSummary = [
    input.greenfield
      ? `**${input.projectName}** — new project, no codebase yet.`
      : `**${input.projectName}** — imported ${input.sourceRef ? `from \`${input.sourceRef}\`` : "as a new codebase"}.`,
    ``,
    `Business objective: ${input.objective}`,
    input.constraints ? `\nConstraints: ${input.constraints}` : "",
    ``,
    input.greenfield
      ? `No repository was imported, so no analyzers ran. The plan below comes from the objective.`
      : `Intake ran ${input.analyzers.length} analyzers (${ok} ok, ${failed} degraded). ` +
        `Dominant file types: ${langLine}. Default branch \`${input.ingest.defaultBranch}\` at \`${input.ingest.headCommit.slice(0, 12)}\`, ` +
        `${input.ingest.branches.length} branch(es), ~${Math.round(input.ingest.sizeKb / 1024)} MB bare.`,
  ]
    .filter(Boolean)
    .join("\n");

  const body: Record<(typeof INTAKE_REPORT_SECTIONS)[number], string> = {
    // The model's summary REPLACES the stats line only when it exists; the
    // objective + provenance header stays either way so the report is always
    // self-describing.
    "Executive summary": input.synthesis?.executiveSummary
      ? `${input.synthesis.executiveSummary.trim()}\n\n---\n\n${deterministicSummary}`
      : deterministicSummary,
    "Repository profile": repoSection("repo_profile"),
    "Technology stack": repoSection("languages"),
    "Architecture assessment": repoSection("structure"),
    "Dependency health": repoSection("dependencies"),
    "Data layer": synth(
      input,
      "dataLayer",
      input.greenfield
        ? GREENFIELD
        : UNAVAILABLE + "\n\n> db-schema analyzer lands with the engineering deep-dive",
    ),
    "API surface": synth(
      input,
      "apiSurface",
      input.greenfield
        ? GREENFIELD
        : UNAVAILABLE + "\n\n> api-surface analyzer lands with the engineering deep-dive",
    ),
    "Test & CI status": repoSection("tests"),
    "Configuration & environments": repoSection("config_env"),
    "Documentation state": repoSection("docs"),
    "Security findings": repoSection("security_smells"),
    "Technical debt register": synth(
      input,
      "technicalDebt",
      input.greenfield
        ? GREENFIELD
        : UNAVAILABLE + "\n\n> ranked debt register lands with quality metrics",
    ),
    "Quality metrics": synth(
      input,
      "qualityMetrics",
      input.greenfield
        ? GREENFIELD
        : UNAVAILABLE + "\n\n> complexity/churn metrics land with quality tooling",
    ),
    "Product/market signals": synth(input, "productSignals", UNAVAILABLE),
    "Recommended plan": synth(
      input,
      "recommendedPlan",
      [
        `1. CEO frames the GOAL from the business objective (attached to the routed task).`,
        `2. CTO runs the technical assessment over sections 2–13.`,
        `3. Leads review their areas; the Architect proposes the target design.`,
        `4. Decomposition into EPICs/TASKs through the standard delegation engine.`,
      ].join("\n"),
    ),
    "Open questions for the organization": synth(
      input,
      "openQuestions",
      input.greenfield
        ? [
            `- What is the smallest first release that proves the objective?`,
            `- Which constraints are hard (budget, deadline, stack) and which are preferences?`,
            `- Who is the first user, and how will we know the objective was met?`,
          ].join("\n")
        : [
            `- Which areas of the codebase does the objective touch first?`,
            `- Are the degraded analyzer sections (${failed}) worth a manual deep-dive?`,
            `- Does the dependency surface need an upgrade pass before feature work?`,
          ].join("\n"),
    ),
  };

  const lines: string[] = [`# Project Intake Report — ${input.projectName}`, ``];
  INTAKE_REPORT_SECTIONS.forEach((heading, i) => {
    lines.push(`## ${i + 1}. ${heading}`, ``, body[heading], ``);
  });
  return lines.join("\n");
}

/** One-line summary for `project.analysis.completed` (10 §10). */
export function findingsSummary(input: ReportInput): string {
  const ok = input.analyzers.filter((a) => a.ok).length;
  const security = input.analyzers.find((a) => a.analyzer === "security_smells" && a.ok);
  const hits = security
    ? ((security.findings as { findings?: unknown[] }).findings?.length ?? 0)
    : 0;
  return (
    `${ok}/${input.analyzers.length} analyzers ok; ` +
    `${input.ingest.branches.length} branches; ${hits} security finding(s)`
  );
}
