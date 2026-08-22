import { useEffect, useMemo, useState } from "react";
import { AlertCircle, ArrowDownToLine, CheckCircle2, FileSearch, KeyRound, LogOut, ScanSearch, ShieldCheck, UploadCloud, WandSparkles, X } from "lucide-react";

const actionInfo = {
  clean: { label: "Clean", icon: WandSparkles, description: "Remove supported metadata and invisible marks." },
  inspect: { label: "Inspect", icon: FileSearch, description: "Review file type and suspicious signals." },
  detect: { label: "Detect", icon: ScanSearch, description: "Run configured watermark detectors." },
};
const API_BASE = (process.env.REACT_APP_BACKEND_URL || "").replace(/\/+$/, "");
const apiUrl = (path) => `${API_BASE}${path}`;

const humanizeAction = (raw) => {
  const s = String(raw);
  if (s.startsWith("drop part")) return `Removed hidden metadata part (${s.replace("drop part", "").trim()})`;
  if (s.startsWith("drop Content_Types")) return "Removed unused content-type overrides";
  if (s.startsWith("scrub docProps")) {
    const field = s.split("field")[1]?.trim() || "";
    const map = { "dc:creator": "author name", "cp:lastModifiedBy": "last-modified-by name", "Application": "authoring app name", "AppVersion": "authoring app version" };
    return `Scrubbed ${map[field] || field} from document properties`;
  }
  if (s.startsWith("prune dangling relationships")) return "Removed dangling internal relationship links";
  if (s.startsWith("layer A text")) {
    const rep = /replaced=(\d+)/.exec(s)?.[1] || "0";
    const rem = /removed=(\d+)/.exec(s)?.[1] || "0";
    return `Cleaned invisible/zero-width text markers (${rep} replaced, ${rem} removed)`;
  }
  if (s.startsWith("layer B")) return "Rewrote suspicious watermarked passages";
  return s;
};

const fmtBytes = (n) => {
  if (n === undefined || n === null) return "";
  if (n < 1024) return `${n} B`;
  if (n < 1024 * 1024) return `${(n / 1024).toFixed(1)} KB`;
  return `${(n / 1024 / 1024).toFixed(2)} MB`;
};

function CleanSummary({ result }) {
  const report = result.report || {};
  const stillC2pa = report.still_has_c2pa === true;
  const stillAi = report.still_has_ai_metadata === true;
  const findings = Array.isArray(report.post_findings) ? report.post_findings : [];
  const actions = Array.isArray(report.actions) ? report.actions : [];
  const clean = result.ok && !stillC2pa && !stillAi && findings.length === 0;
  const shrink = (report.bytes_in && report.bytes_out) ? report.bytes_in - report.bytes_out : 0;
  const pct = report.bytes_in ? ((shrink / report.bytes_in) * 100).toFixed(1) : "0";
  return <div className={`verdict ${clean ? "ok" : "warn"}`} data-testid={`clean-verdict-${result.name}`}>
    <div className="verdict-head">{clean ? <><CheckCircle2 size={18} /> <strong>This file is clean</strong></> : <><AlertCircle size={18} /> <strong>Some traces may remain</strong></>}<span className="verdict-format">{report.format || result.kind || "file"}</span></div>
    <ul className="verdict-list">
      <li><span className={stillAi ? "bad" : "ok"}>{stillAi ? "✗" : "✓"}</span> {stillAi ? "AI-tool metadata still present" : "No AI-tool metadata left"}</li>
      <li><span className={stillC2pa ? "bad" : "ok"}>{stillC2pa ? "✗" : "✓"}</span> {stillC2pa ? "C2PA provenance still present" : "No C2PA provenance left"}</li>
      <li><span className={findings.length ? "bad" : "ok"}>{findings.length ? "✗" : "✓"}</span> {findings.length ? `${findings.length} finding${findings.length > 1 ? "s" : ""} remain after cleaning` : "No remaining suspicious findings"}</li>
      {shrink > 0 && <li><span className="ok">✓</span> Shrunk by {fmtBytes(shrink)} ({pct}% smaller)</li>}
    </ul>
    {actions.length > 0 && <details className="verdict-actions"><summary>What was removed ({actions.length} change{actions.length > 1 ? "s" : ""})</summary><ul>{actions.map((a, i) => <li key={i}>{humanizeAction(a)}</li>)}</ul></details>}
  </div>;
}

function InspectSummary({ result }) {
  const report = result.report || {};
  const findings = Array.isArray(report.findings) ? report.findings : [];
  const suspicious = result.suspicious === true;
  const tools = report.tools || {};
  const unavailable = Object.entries(tools).filter(([, v]) => v && v.available === false).map(([k]) => k);
  const limited = !suspicious && unavailable.length > 0;
  const tone = suspicious ? "warn" : limited ? "info" : "ok";
  const title = suspicious ? "Suspicious signals found" : limited ? "Limited scan — nothing found so far" : "Nothing suspicious";
  return <div className={`verdict ${tone}`} data-testid={`inspect-verdict-${result.name}`}>
    <div className="verdict-head">{suspicious ? <AlertCircle size={18} /> : limited ? <FileSearch size={18} /> : <CheckCircle2 size={18} />} <strong>{title}</strong><span className="verdict-format">{report.format || result.kind || "file"}</span></div>
    <ul className="verdict-list">
      <li><span className={report.has_ai_metadata ? "bad" : "ok"}>{report.has_ai_metadata ? "!" : "✓"}</span> {report.has_ai_metadata ? "AI-tool metadata present" : "No AI-tool metadata found"}</li>
      <li><span className={report.has_c2pa ? "bad" : "ok"}>{report.has_c2pa ? "!" : "✓"}</span> {report.has_c2pa ? "C2PA provenance present" : "No C2PA provenance found"}</li>
      <li><span className={findings.length ? "bad" : "ok"}>{findings.length ? "!" : "✓"}</span> {findings.length ? `${findings.length} finding${findings.length > 1 ? "s" : ""}: ${findings.slice(0, 3).map((f) => (typeof f === "string" ? f : f.kind || f.type || "signal")).join(", ")}${findings.length > 3 ? "…" : ""}` : "No suspicious findings"}</li>
    </ul>
    {unavailable.length > 0 && <p className="verdict-note" data-testid={`inspect-limited-${result.name}`}><strong>Heads-up:</strong> {unavailable.join(" and ")} {unavailable.length > 1 ? "are" : "is"} not installed on the server, so parts of the scan were skipped. Install {unavailable.join(" / ")} on <code>wr-core</code> for a full check.</p>}
    <details className="verdict-actions"><summary>What this scan does &amp; doesn&apos;t do</summary><ul>
      <li><strong>Checks:</strong> C2PA manifests, EXIF/XMP author &amp; software tags, docProps in Office files, hidden <code>customXml</code> parts, zero-width / invisible characters, PDF ONNX signatures, EPUB generator hints.</li>
      <li><strong>Does not check:</strong> statistical AI writing style (perplexity, burstiness). A file copy-pasted from ChatGPT into Word carries zero metadata — no scanner can flag it. For style-based detection you need a tool like GPTZero or a classifier model.</li>
    </ul></details>
  </div>;
}

function DetectSummary({ result }) {
  const FLAGGED_LEVELS = ["LOW", "MEDIUM", "HIGH"];
  const fmtThreshold = (t) => { const n = Number(t); if (!isFinite(n)) return ""; if (Math.abs(n) < 0.01 && n !== 0) return n.toExponential(1); return n.toFixed(2); };
  const dets = Array.isArray(result.detections) ? result.detections : [];
  const isText = result.kind === "text";
  const available = dets.filter((d) => d.available === true);
  const unavailable = dets.filter((d) => d.available === false);
  const matched = available.filter((d) => d.is_watermarked === true || (typeof d.confidence_level === "string" && FLAGGED_LEVELS.includes(d.confidence_level.toUpperCase())));
  const tone = matched.length ? "warn" : available.length ? "ok" : "info";
  const title = matched.length ? `${matched.length} detector${matched.length > 1 ? "s" : ""} flagged this file` : available.length ? `${available.length} detector${available.length > 1 ? "s" : ""} ran — nothing matched` : dets.length === 0 && !isText ? "Text detectors were skipped" : "No detectors are configured";
  const disabledReason = (d) => {
    if (d.detector === "claude-text") return "no public API yet";
    if (d.detector === "markllm") return "MARKLLM_DIR not set";
    if (d.detector === "gumbel") return "WATERMARKS_GUMBEL_KEY not set";
    return d.error ? d.error.split(/[.;]/)[0] : "not configured";
  };
  const detectorRow = (d, i) => {
    if (d.available === false) return <li key={i}><span className="det-off">·</span> <strong>{d.detector}</strong> — <em>disabled</em> ({disabledReason(d)})</li>;
    if (d.detector === "gumbel") {
      const flagged = d.is_watermarked === true;
      const score = d.score !== undefined ? ` (score ${Number(d.score).toFixed(2)}${d.threshold !== undefined ? ` / threshold ${fmtThreshold(d.threshold)}` : ""})` : "";
      return <li key={i}><span className={flagged ? "bad" : "ok"}>{flagged ? "!" : "✓"}</span> <strong>Gumbel (keyed watermark)</strong> — {flagged ? "watermark detected" : "no watermark"}{score}</li>;
    }
    if (d.detector === "stylometry") {
      const lvl = String(d.confidence_level || "").toUpperCase();
      const flagged = FLAGGED_LEVELS.includes(lvl);
      const note = d.status === "insufficient_length" ? " (need ≥ 30 words)" : "";
      return <li key={i}><span className={flagged ? "bad" : "ok"}>{flagged ? "!" : "✓"}</span> <strong>Stylometry (AI-writing signals)</strong> — {flagged ? `likely AI (${lvl})` : lvl === "CLEAN" ? "no AI signals" : lvl || "no signals"}{note}{d.score !== undefined ? ` · score ${Number(d.score).toFixed(2)}` : ""}</li>;
    }
    return <li key={i}><span className={d.is_watermarked ? "bad" : "ok"}>{d.is_watermarked ? "!" : "✓"}</span> <strong>{d.detector}</strong>{d.score !== undefined ? ` — score ${Number(d.score).toFixed(2)}` : ""}</li>;
  };
  return <div className={`verdict ${tone}`} data-testid={`detect-verdict-${result.name}`}>
    <div className="verdict-head">{matched.length ? <AlertCircle size={18} /> : available.length ? <CheckCircle2 size={18} /> : <FileSearch size={18} />} <strong>{title}</strong><span className="verdict-format">{result.kind || "file"}</span></div>
    {dets.length === 0 && !isText && <p className="verdict-note">Detect only runs on plain-text files. This file was recognised as <code>{result.kind || "binary"}</code>, so no text detectors were run. Try Inspect / Clean instead, or extract the text first.</p>}
    {dets.length === 0 && isText && <p className="verdict-note">No detectors are enabled on <code>wr-core</code>. Set <code>WATERMARKS_GUMBEL_KEY</code> (keyed watermark replay) or <code>MARKLLM_DIR</code> (research harness) in the environment. Stylometry runs automatically for text ≥ 30 words.</p>}
    {dets.length > 0 && <ul className="verdict-list det-list">{dets.map(detectorRow)}</ul>}
    {unavailable.length > 0 && dets.length > 0 && <p className="verdict-note"><strong>{unavailable.length} detector{unavailable.length > 1 ? "s" : ""} disabled:</strong> {unavailable.map((d) => d.detector).join(", ")}. Enable them by setting the matching env variables on <code>wr-core</code> (see the technical report for the specific variable names).</p>}
    <details className="verdict-actions"><summary>What each detector does</summary><ul>
      <li><strong>Gumbel</strong> — replays the keyed-Gumbel (Aaronson EXP) watermark. Only fires for text generated with the SAME key you configured; not a universal AI detector.</li>
      <li><strong>Stylometry</strong> — statistical writing-style analysis (burstiness, lexical diversity, AI-phrase n-grams). Flags likely AI-written text — the closest thing to a general AI-content check the tool has.</li>
      <li><strong>MarkLLM</strong> — research harness that replays multiple watermark schemes; needs a MarkLLM checkout on the server.</li>
      <li><strong>Claude-text</strong> — placeholder for Anthropic&apos;s announced detection API; no public endpoint exists yet.</li>
    </ul></details>
  </div>;
}

const readFile = (file) => new Promise((resolve, reject) => {
  const reader = new FileReader();
  reader.onload = () => resolve({ name: file.name, file: reader.result.split(",")[1] });
  reader.onerror = reject;
  reader.readAsDataURL(file);
});

function ChangePasswordModal({ onClose, onSuccess }) {
  const [form, setForm] = useState({ current_password: "", new_password: "", confirm_password: "" });
  const [error, setError] = useState("");
  const [busy, setBusy] = useState(false);
  const submit = async (event) => {
    event.preventDefault(); setError("");
    if (form.new_password !== form.confirm_password) { setError("New passwords do not match"); return; }
    if (form.new_password.length < 8) { setError("New password must be at least 8 characters"); return; }
    setBusy(true);
    try {
      const response = await fetch(apiUrl("/api/change-password"), { method: "POST", credentials: "include", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ current_password: form.current_password, new_password: form.new_password }) });
      const data = await response.json().catch(() => ({}));
      if (!response.ok) { setError(data.detail || "Unable to update password"); setBusy(false); return; }
      onSuccess();
    } catch { setError("Unable to reach the dashboard service. Please try again."); setBusy(false); }
  };
  return <div className="modal-backdrop" data-testid="password-modal" onClick={onClose}><form className="modal-card" onClick={(e) => e.stopPropagation()} onSubmit={submit}><button type="button" className="modal-close" data-testid="password-modal-close" onClick={onClose}><X size={16} /></button><div className="brand-mark"><KeyRound size={20} /></div><div className="eyebrow">ACCOUNT SECURITY</div><h2>Change password</h2><p className="muted">Update the admin password used to sign in to this workspace.</p><label>Current password<input data-testid="current-password-input" type="password" value={form.current_password} onChange={(e) => setForm({ ...form, current_password: e.target.value })} autoComplete="current-password" required /></label><label>New password<input data-testid="new-password-input" type="password" value={form.new_password} onChange={(e) => setForm({ ...form, new_password: e.target.value })} autoComplete="new-password" required minLength={8} /></label><label>Confirm new password<input data-testid="confirm-password-input" type="password" value={form.confirm_password} onChange={(e) => setForm({ ...form, confirm_password: e.target.value })} autoComplete="new-password" required minLength={8} /></label>{error && <div className="error" data-testid="password-modal-error"><AlertCircle size={16} />{error}</div>}<button className="primary full" data-testid="password-modal-submit" disabled={busy}>{busy ? "Updating…" : "Update password"}</button><small className="muted">Minimum 8 characters. You&apos;ll stay signed in after the change.</small></form></div>;
}

function Login({ onLogin, initialError = "" }) {
  const [form, setForm] = useState({ username: "", password: "" });
  const [error, setError] = useState(initialError);
  const submit = async (event) => {
    event.preventDefault(); setError("");
    try {
      const response = await fetch(apiUrl("/api/login"), { method: "POST", credentials: "include", headers: { "Content-Type": "application/json" }, body: JSON.stringify(form) });
      if (!response.ok) { setError((await response.json()).detail || "Unable to sign in"); return; }
      onLogin(await response.json());
    } catch { setError("Unable to reach the dashboard service. Please try again."); }
  };
  return <main className="login-shell"><div className="login-art"><div className="eyebrow">PRIVATE WORKSPACE</div><h1>Clean the signal.<br /><em>Keep the substance.</em></h1><p>A focused workspace for inspecting and cleaning the files you own.</p><div className="orbit"><ShieldCheck size={34} /><span>Local-first processing</span></div></div><form className="login-card" onSubmit={submit} data-testid="login-form"><div className="brand-mark"><ShieldCheck size={20} /></div><div className="eyebrow">ADMIN ACCESS</div><h2>Welcome back</h2><p className="muted">Sign in to open your private cleaning desk.</p><label>Username<input data-testid="login-username-input" value={form.username} onChange={(e) => setForm({ ...form, username: e.target.value })} autoComplete="username" required /></label><label>Password<input data-testid="login-password-input" type="password" value={form.password} onChange={(e) => setForm({ ...form, password: e.target.value })} autoComplete="current-password" required /></label>{error && <div className="error" data-testid="login-error"><AlertCircle size={16} />{error}</div>}<button className="primary full" data-testid="login-submit-button">Enter workspace</button><small className="muted">Credentials are configured by your administrator.</small></form></main>;
}

function App() {
  const [user, setUser] = useState(null); const [sessionError, setSessionError] = useState(""); const [action, setAction] = useState("clean"); const [files, setFiles] = useState([]); const [results, setResults] = useState([]); const [busy, setBusy] = useState(false); const [error, setError] = useState(""); const [showPasswordModal, setShowPasswordModal] = useState(false); const [notice, setNotice] = useState("");
  useEffect(() => { fetch(apiUrl("/api/session"), { credentials: "include" }).then((r) => r.json()).then((data) => { if (data.authenticated) setUser({ username: "admin" }); }).catch(() => setSessionError("Unable to reach the dashboard service. You can try signing in again.")); }, []);
  useEffect(() => { if (!notice) return; const t = setTimeout(() => setNotice(""), 5000); return () => clearTimeout(t); }, [notice]);
  const current = actionInfo[action]; const totalSize = useMemo(() => files.reduce((sum, file) => sum + file.size, 0), [files]);
  if (!user) return <Login onLogin={setUser} initialError={sessionError} />;
  const addFiles = (incoming) => { setFiles([...files, ...Array.from(incoming).map((file) => ({ raw: file, name: file.name, size: file.size }))]); setResults([]); setError(""); };
  const run = async () => { if (!files.length) return; setBusy(true); setError(""); setResults([]); try { const encoded = await Promise.all(files.map((file) => readFile(file.raw))); const response = await fetch(apiUrl(`/api/action/${action}`), { method: "POST", credentials: "include", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ files: encoded }) }); const data = await response.json(); if (!response.ok) throw new Error(data.detail || "The service could not process these files"); setResults(data.results || []); } catch (err) { setError(err.message); } finally { setBusy(false); } };
  const logout = async () => { try { const response = await fetch(apiUrl("/api/logout"), { method: "POST", credentials: "include" }); if (!response.ok) throw new Error(); setUser(null); } catch { setError("Unable to sign out right now. Please try again."); } };
  const download = (result) => { const bytes = Uint8Array.from(atob(result.cleaned), (char) => char.charCodeAt(0)); const url = URL.createObjectURL(new Blob([bytes])); const anchor = document.createElement("a"); anchor.href = url; anchor.download = `cleaned-${result.name}`; anchor.click(); URL.revokeObjectURL(url); };
  return <div className="app-shell"><header className="topbar"><div className="logo"><span className="logo-icon"><ShieldCheck size={18} /></span><span>watermarks<span className="logo-dim">/remover</span></span></div><div className="topbar-right"><span className="status-dot" data-testid="service-status">Private workspace</span><button className="ghost" data-testid="change-password-button" onClick={() => { setShowPasswordModal(true); setNotice(""); }}><KeyRound size={16} /> Change password</button><button className="ghost" data-testid="logout-button" onClick={logout}><LogOut size={16} /> Sign out</button></div></header>{showPasswordModal && <ChangePasswordModal onClose={() => setShowPasswordModal(false)} onSuccess={() => { setShowPasswordModal(false); setNotice("Password updated successfully."); }} />}<main className="workspace">{notice && <div className="notice" data-testid="password-notice"><CheckCircle2 size={16} />{notice}</div>}<section className="hero"><div><div className="eyebrow">FILE HYGIENE DESK</div><h1>Make every file<br /><em>read clean.</em></h1><p>Inspect provenance signals, detect configured marks, or clean supported files in one quiet workspace.</p></div><div className="hero-note"><span>01</span><strong>Your files stay in memory</strong><small>Nothing is saved after each result.</small></div></section><section className="tool-grid"><aside className="action-panel"><div className="panel-label">CHOOSE AN ACTION</div>{Object.entries(actionInfo).map(([key, info]) => { const Icon = info.icon; return <button key={key} className={`action-choice ${action === key ? "selected" : ""}`} data-testid={`action-${key}-button`} onClick={() => { setAction(key); setResults([]); }}><Icon size={20} /><span><strong>{info.label}</strong><small>{info.description}</small></span><b>{action === key ? "Selected" : ""}</b></button>; })}<div className="privacy-card"><ShieldCheck size={19} /><div><strong>Private by design</strong><p>Files are processed in memory and removed immediately after the response.</p></div></div></aside><section className="work-panel"><div className="panel-heading"><div><div className="eyebrow">{String(action).toUpperCase()} MODE</div><h2>{current.label} files</h2></div><span className="file-count" data-testid="selected-file-count">{files.length} selected</span></div><label className="dropzone" data-testid="file-dropzone"><input data-testid="file-upload-input" type="file" multiple onChange={(e) => { addFiles(e.target.files); e.target.value = ""; }} /><UploadCloud size={30} /><strong>Drop files here or browse</strong><span>Batch up to 50 supported files · {totalSize ? `${(totalSize / 1024 / 1024).toFixed(1)} MB selected` : "No files selected"}</span></label>{files.length > 0 && <div className="file-list" data-testid="selected-files-list">{files.map((file, index) => <div className="file-row" key={`${file.name}-${index}`}><div className="file-badge">{file.name.split(".").pop()?.toUpperCase()}</div><span>{file.name}<small>{(file.size / 1024).toFixed(0)} KB</small></span><button className="remove-file" data-testid={`remove-file-${index}-button`} onClick={() => setFiles(files.filter((_, i) => i !== index))}>Remove</button></div>)}</div>}{error && <div className="error" data-testid="action-error"><AlertCircle size={17} />{error}</div>}<button className="primary run-button" data-testid={`run-${action}-button`} disabled={!files.length || busy} onClick={run}>{busy ? "Processing files…" : `${current.label} ${files.length ? `${files.length} file${files.length > 1 ? "s" : ""}` : "files"}`}<span>↗</span></button></section></section>{results.length > 0 && <section className="results" data-testid="results-section"><div className="panel-heading"><div><div className="eyebrow">RESULTS</div><h2>Review your files</h2></div><span className="success-pill"><CheckCircle2 size={15} /> Complete</span></div><div className="result-grid">{results.map((result, index) => <article className="result-card" key={`${result.name}-${index}`} data-testid={`result-card-${index}`}><div className="result-title"><div className="file-badge">{result.name.split(".").pop()?.toUpperCase()}</div><strong>{result.name}</strong>{result.ok ? <CheckCircle2 className="ok" size={18} /> : <AlertCircle className="bad" size={18} />}</div>{result.ok && action === "clean" && <CleanSummary result={result} />}{result.ok && action === "inspect" && <InspectSummary result={result} />}{result.ok && action === "detect" && <DetectSummary result={result} />}{!result.ok && result.error && <div className="error" data-testid={`result-error-${index}`}><AlertCircle size={17} />{result.error}</div>}{action === "clean" && result.cleaned && <button className="download" data-testid={`download-result-${index}-button`} onClick={() => download(result)}><ArrowDownToLine size={16} /> Download cleaned file</button>}<details><summary data-testid={`result-report-toggle-${index}`}>Technical report (JSON)</summary><pre data-testid={`result-report-${index}`}>{JSON.stringify(action === "detect" ? result.detections : result.report, null, 2)}</pre></details></article>)}</div></section>}</main><footer><span>watermarks/remover</span><span>For content you own or are authorized to process.</span></footer></div>;
}

export default App;