// U01 (36 §2) — acosDark theme preview: surface/text tokens, department
// accents, presence pills, buttons, and a mock command-center panel. Pure
// presentational gallery; no data fetching. The dark shell itself lands in U02.
import {
  acosDarkCss,
  acosDarkSurfaces,
  acosDarkText,
  departmentColors,
  presenceColors,
} from "@acos/ui";

const previewCss = `${acosDarkCss}
.theme-preview ::-webkit-scrollbar{width:8px;height:8px}
.theme-preview ::-webkit-scrollbar-thumb{background:#232b36;border-radius:4px}
.theme-preview ::-webkit-scrollbar-track{background:transparent}`;

function SectionTitle({ children }: { children: string }) {
  return (
    <h2 className="mb-2 mt-6 text-[10px] font-semibold uppercase tracking-wider text-acos-fg2">
      {children}
    </h2>
  );
}

function Swatch({ name, value, text }: { name: string; value: string; text?: string }) {
  return (
    <div className="flex items-center gap-2 rounded-md border border-acos-line bg-acos-bg1 px-2.5 py-2">
      <span
        className="h-7 w-7 shrink-0 rounded border border-acos-line"
        style={{ background: value }}
      />
      <div className="min-w-0">
        <div className="text-[11px] font-semibold" style={text ? { color: text } : undefined}>
          {name}
        </div>
        <div className="font-mono text-[10px] tabular-nums text-acos-fg2">{value}</div>
      </div>
    </div>
  );
}

function PresencePill({ status, color }: { status: string; color: string }) {
  return (
    <span
      className="inline-flex items-center gap-1.5 rounded-full border border-acos-line bg-acos-bg2 px-2 py-0.5 text-[10px] font-medium"
      style={{ color }}
    >
      <span className="h-1.5 w-1.5 rounded-full" style={{ background: color }} />
      {status}
    </span>
  );
}

function MockPanel() {
  return (
    <div className="flex h-64 w-full max-w-xl flex-col overflow-hidden rounded-[7px] border border-acos-line bg-acos-bg1">
      {/* 28px panel header with tabs (36 §2 density) */}
      <div className="flex h-7 items-center gap-0.5 border-b border-acos-line bg-acos-bg2 px-1.5">
        <span className="rounded-t-md border border-b-0 border-acos-line bg-acos-bg1 px-2.5 py-1 text-[10.5px] text-acos-fg0">
          Hafıza
        </span>
        <span className="px-2.5 py-1 text-[10.5px] text-acos-fg1">Skiller</span>
        <span className="px-2.5 py-1 text-[10.5px] text-acos-fg1">
          Tarayıcı <span className="text-[8px] text-acos-fg2">P2</span>
        </span>
        <span className="ml-auto flex items-center gap-1 pr-1 text-[9.5px] text-acos-fg2">
          yoğunluk:
          <span className="rounded border border-acos-line bg-acos-bg3 px-1.5 text-acos-fg1">S</span>
          <span className="rounded border border-dept-engineering bg-dept-engineering px-1.5 font-semibold text-acos-bg0">
            M
          </span>
          <span className="rounded border border-acos-line bg-acos-bg3 px-1.5 text-acos-fg1">L</span>
        </span>
      </div>
      <div className="min-h-0 flex-1 overflow-auto">
        {[
          ["Signup e2e order-dependent", "failure", presenceColors.blocked, "project"],
          ["Squash-merge tercih", "procedural", presenceColors.thinking, "agent"],
          ["OAuth state=CSRF", "semantic", presenceColors.waiting, "company"],
          ["N+1 → join", "failure", presenceColors.blocked, "project"],
        ].map(([title, kind, color, scope]) => (
          <div key={title} className="border-b border-acos-line/50 px-2.5 py-1.5">
            <div className="text-[11px] font-semibold text-acos-fg0">{title}</div>
            <div className="mt-0.5 flex items-center gap-1.5">
              <span
                className="rounded-full px-1.5 text-[8.5px]"
                style={{ background: `${color}22`, color }}
              >
                {kind}
              </span>
              <span className="rounded-full bg-acos-bg3 px-1.5 text-[8.5px] text-acos-fg1">
                {scope}
              </span>
              <span className="ml-auto font-mono text-[9px] tabular-nums text-acos-fg2">
                conf 0.85
              </span>
            </div>
          </div>
        ))}
      </div>
      <div className="flex h-6 items-center gap-3 border-t border-acos-line bg-acos-bg1 px-2.5 text-[10px] text-acos-fg1">
        <span style={{ color: departmentColors.operations }}>● ws: open</span>
        <span>
          son: <b className="font-mono text-acos-fg0">review.completed</b>
        </span>
        <span className="ml-auto font-mono tabular-nums">
          $ <b className="text-acos-fg0">2.95</b>/20
        </span>
      </div>
    </div>
  );
}

export function ThemePreviewPage() {
  return (
    <div className="theme-preview min-h-screen bg-acos-bg0 p-6 font-sans text-[13px] text-acos-fg0">
      <style>{previewCss}</style>
      <header className="flex items-baseline gap-3">
        <h1 className="text-base font-bold">
          A<b style={{ color: departmentColors.operations }}>C</b>OS — acosDark Tema Önizleme
        </h1>
        <span className="text-[11px] text-acos-fg2">U01 · 36 §2 token seti</span>
      </header>

      <SectionTitle>Yüzeyler + metin</SectionTitle>
      <div className="grid max-w-4xl grid-cols-2 gap-2 sm:grid-cols-4">
        {Object.entries(acosDarkSurfaces).map(([name, value]) => (
          <Swatch key={name} name={`--${name}`} value={value} />
        ))}
        {Object.entries(acosDarkText).map(([name, value]) => (
          <Swatch key={name} name={`--${name}`} value={value} text={value} />
        ))}
      </div>

      <SectionTitle>Departman vurguları</SectionTitle>
      <div className="grid max-w-4xl grid-cols-2 gap-2 sm:grid-cols-4">
        {Object.entries(departmentColors).map(([name, value]) => (
          <Swatch key={name} name={name} value={value} text={value} />
        ))}
      </div>

      <SectionTitle>Presence (11 durum)</SectionTitle>
      <div className="flex max-w-4xl flex-wrap gap-1.5">
        {Object.entries(presenceColors).map(([status, color]) => (
          <PresencePill key={status} status={status} color={color} />
        ))}
      </div>

      <SectionTitle>Tipografi</SectionTitle>
      <div className="max-w-xl rounded-md border border-acos-line bg-acos-bg1 px-3 py-2.5">
        <p className="text-[13px]">Inter 13px — yoğun komuta merkezi arayüz metni.</p>
        <p className="mt-1 font-mono text-[11px] tabular-nums text-acos-fg1">
          JetBrains Mono · tabular 0123456789 · $2.95/20.00 · seq 1042
        </p>
      </div>

      <SectionTitle>Butonlar</SectionTitle>
      <div className="flex flex-wrap items-center gap-2">
        <button
          className="rounded-md border px-2.5 py-1 text-[11px] font-semibold text-white"
          style={{ background: departmentColors.product, borderColor: departmentColors.product }}
        >
          + Ajan Ekle
        </button>
        <button className="rounded-md border border-acos-line bg-acos-bg2 px-2.5 py-1 text-[11px] text-acos-fg1 hover:bg-acos-bg3">
          İptal
        </button>
        <button className="rounded-md border border-dept-engineering bg-dept-engineering/10 px-2.5 py-1 text-[11px] font-medium text-dept-engineering">
          ⤢ öne çıkar
        </button>
        <button
          className="rounded-md border-none px-2.5 py-1 text-[11px] font-semibold"
          style={{ background: "#2ec26a", color: "#04120a" }}
        >
          ↑ Terfi Et
        </button>
        <button
          className="rounded-md border px-2.5 py-1 text-[11px] font-semibold text-white"
          style={{ background: presenceColors.escalating, borderColor: presenceColors.escalating }}
        >
          Durdur
        </button>
      </div>

      <SectionTitle>Örnek panel</SectionTitle>
      <MockPanel />
    </div>
  );
}
