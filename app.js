const $ = (selector) => document.querySelector(selector);
const MAX_FILE_SIZE = 10 * 1024 * 1024;
let currentPacket = null;
let resumePreviewUrl = null;
let resumePreviewBlob = null;
let resumeTextDirty = false;
let resumePageCustomized = false;
let lastKeywordUndo = null;
const GEMINI_MODEL = 'gemini-3.1-flash-lite';

function notify(message) {
  const toast = $('#toast');
  toast.textContent = message;
  toast.classList.add('show');
  window.setTimeout(() => toast.classList.remove('show'), 2600);
}

function setStatus(message) { $('#status').textContent = message; }

function loadScript(globalName, url) {
  if (window[globalName]) return Promise.resolve();
  return new Promise((resolve, reject) => {
    const script = document.createElement('script');
    script.src = url;
    script.onload = () => window[globalName] ? resolve() : reject(new Error('Library failed to initialize'));
    script.onerror = reject;
    document.head.appendChild(script);
  });
}

function pdfItemsToLines(items) {
  const rows = new Map();
  for (const item of items) {
    if (!item.str?.trim()) continue;
    const transform = item.transform || [];
    const y = Math.round((transform[5] || 0) * 2) / 2;
    const fontSize = Math.hypot(transform[0] || 0, transform[1] || 0) || 10;
    const row = rows.get(y) || [];
    row.push({ x: transform[4] || 0, width: item.width || 0, fontSize, raw: item.str, text: item.str.replace(/\uFFFD/g, '•').trim() });
    rows.set(y, row);
  }
  const orderedRows = [...rows.entries()].sort((a, b) => b[0] - a[0]);
  const lines = [];
  let previousY;
  let previousFontSize = 10;
  for (const [y, row] of orderedRows) {
    row.sort((a, b) => a.x - b.x);
    let line = '';
    let previous;
    for (const item of row) {
      if (!item.text) continue;
      if (previous) {
        const gap = item.x - (previous.x + previous.width);
        if (/\s$/.test(previous.raw) || /^\s/.test(item.raw) || gap > Math.max(1.2, item.fontSize * 0.2)) line += ' ';
      }
      line += item.text;
      previous = item;
    }
    if (!line) continue;
    const fontSize = row.reduce((sum, item) => sum + item.fontSize, 0) / row.length;
    if (previousY !== undefined && previousY - y > Math.max(10, Math.max(fontSize, previousFontSize) * 1.55)) lines.push('');
    lines.push(line.replace(/[\t ]+/g, ' ').trim());
    previousY = y;
    previousFontSize = fontSize;
  }
  return lines;
}

function reflowPdfResumeText(text) {
  const heading = /^(?:PROFESSIONAL\s+)?SUMMARY$|^PROFILE$|^OBJECTIVE$|^(?:TECHNICAL\s+)?SKILLS$|^CORE COMPETENCIES$|^(?:PROFESSIONAL\s+|WORK\s+)?EXPERIENCE$|^PROJECTS$|^EDUCATION$|^CERTIFICATIONS?$|^CERTIFICATES$/i;
  const cleanLine = (line) => line.replace(/\u00a0/g, ' ').replace(/[\t ]+/g, ' ').trim()
    .replace(/\s+([,.;:!?])/g, '$1').replace(/\(\s+/g, '(').replace(/\s+\)/g, ')')
    .replace(/\b(hands|full|multi|real|cross|open)\s+-\s+(on|time|cloud|functional|source)\b/gi, '$1-$2');
  const joinWrapped = (previous, line) => /-$/.test(previous) && /^[a-z]/.test(line)
    ? `${previous}${line}`
    : `${previous} ${line}`;
  const output = [];
  let section = '';
  for (const raw of text.split('\n')) {
    const line = cleanLine(raw);
    if (!line) {
      // PDF extraction can add vertical-gap lines between visual rows of one
      // project bullet. Do not let those gaps detach a wrapped continuation.
      if (section.includes('PROJECTS') && output.length && /^[-*•●▪]\s*/.test(output.at(-1))) continue;
      if (output.length && output.at(-1) !== '') output.push('');
      continue;
    }
    if (heading.test(line)) {
      section = line.toUpperCase();
      output.push(line);
      continue;
    }
    const bullet = /^[-*•●▪]\s*/.test(line);
    const projectHeading = section.includes('PROJECTS') && !bullet
      && /^[A-Z0-9]/.test(line)
      && !/^technologies(?:\s+used)?:/i.test(line) && line.length < 110 && !/[.!?]$/.test(line);
    if (projectHeading) {
      output.push(line);
      continue;
    }
    const previous = output.at(-1);
    if (previous && /^[-*•●▪]\s*/.test(previous) && !bullet) output[output.length - 1] = joinWrapped(previous, line);
    else if (previous && section.includes('SUMMARY') && !heading.test(previous)) output[output.length - 1] = joinWrapped(previous, line);
    else if (previous && /SKILLS|COMPETENCIES/.test(section) && !heading.test(previous) && !bullet) output[output.length - 1] = joinWrapped(previous, line);
    else output.push(line);
  }
  return output.join('\n').replace(/\n{3,}/g, '\n\n').trim();
}

function targetText(kind) { return kind === 'resume' ? $('#resumeText') : $('#jdText'); }
function showFilename(kind, name) { $(`#${kind}Name`).textContent = `Selected: ${name}`; }

async function extractFile(file, kind) {
  if (!file) return;
  if (file.size > MAX_FILE_SIZE) { notify('Choose a file smaller than 10 MB.'); return; }
  showFilename(kind, file.name);
  const extension = file.name.split('.').pop().toLowerCase();
  const destination = targetText(kind);
  try {
    if (extension === 'txt') {
      destination.value = await file.text();
      setStatus('Text file loaded.');
      return;
    }
    if (extension === 'docx') {
      setStatus('Reading DOCX…');
      await loadScript('mammoth', 'https://cdnjs.cloudflare.com/ajax/libs/mammoth/1.8.0/mammoth.browser.min.js');
      const result = await mammoth.extractRawText({ arrayBuffer: await file.arrayBuffer() });
      destination.value = result.value;
      setStatus('DOCX text extracted. Review it for accuracy.');
      return;
    }
    if (extension === 'pdf') {
      setStatus('Reading PDF…');
      await loadScript('pdfjsLib', 'https://cdnjs.cloudflare.com/ajax/libs/pdf.js/3.11.174/pdf.min.js');
      pdfjsLib.GlobalWorkerOptions.workerSrc = 'https://cdnjs.cloudflare.com/ajax/libs/pdf.js/3.11.174/pdf.worker.min.js';
      const pdf = await pdfjsLib.getDocument({ data: new Uint8Array(await file.arrayBuffer()) }).promise;
      const pages = [];
      for (let pageNum = 1; pageNum <= pdf.numPages; pageNum += 1) {
        const page = await pdf.getPage(pageNum);
        const content = await page.getTextContent();
        pages.push(pdfItemsToLines(content.items).join('\n'));
      }
      destination.value = reflowPdfResumeText(pages.join('\n\n'));
      setStatus('PDF text extracted. Check for missing text.');
      return;
    }
    if (kind === 'jd' && file.type.startsWith('image/')) {
      setStatus('Reading text from image…');
      await loadScript('Tesseract', 'https://cdn.jsdelivr.net/npm/tesseract.js@5/dist/tesseract.min.js');
      const result = await Tesseract.recognize(file, 'eng');
      destination.value = result.data.text;
      setStatus('OCR complete. Proofread the job description.');
      return;
    }
    notify('That file type is not supported.');
  } catch (error) {
    console.error(error);
    setStatus('Could not extract text. Try another file or paste the text.');
    notify('Text extraction failed. You can paste the text instead.');
  }
}

for (const [kind, input] of [['resume', $('#resumeFile')], ['jd', $('#jdFile')]]) {
  const zone = $(`#${kind}Drop`);
  input.addEventListener('change', () => extractFile(input.files[0], kind));
  zone.addEventListener('dragover', (event) => { event.preventDefault(); zone.classList.add('drag'); });
  zone.addEventListener('dragleave', () => zone.classList.remove('drag'));
  zone.addEventListener('drop', (event) => {
    event.preventDefault();
    zone.classList.remove('drag');
    extractFile(event.dataTransfer.files[0], kind);
  });
}

// A deliberately role-focused vocabulary prevents generic JD prose (for example,
// "knowledge", "managing", and "skills") from dominating the comparison.
const ROLE_TERMS = [
  'DevOps', 'Kubernetes', 'Docker', 'Terraform', 'Ansible', 'AWS', 'Azure', 'GCP', 'Linux',
  'CI/CD', 'Jenkins', 'GitHub Actions', 'GitLab CI', 'Helm', 'Argo CD', 'OpenShift',
  'Infrastructure as Code', 'Platform Engineering', 'Internal Developer Platform',
  'Developer Experience', 'Prometheus', 'Grafana', 'Datadog', 'OpenTelemetry',
  'Observability', 'Monitoring', 'Alerting', 'SRE', 'Site Reliability Engineering',
  'Incident Response', 'On-call', 'Postmortem', 'SLO', 'SLI', 'SLA', 'High Availability',
  'Disaster Recovery', 'Reliability Engineering', 'Toil Reduction', 'Python', 'Bash',
  'Go', 'PowerShell', 'Shell Scripting', 'Networking', 'TCP/IP', 'DNS', 'Load Balancing',
  'Security', 'IAM', 'Secrets Management', 'VPC', 'EKS', 'AKS', 'GKE', 'EC2', 'S3',
  'Lambda', 'CloudWatch', 'Azure DevOps', 'CloudFormation', 'Pulumi', 'Puppet', 'Chef',
  'GitOps', 'Continuous Integration', 'Continuous Delivery', 'Deployment Automation',
  'Release Management', 'Configuration Management', 'Service Mesh', 'Istio', 'Envoy',
  'Containerization', 'Kustomize', 'Backstage', 'Crossplane', 'Vault', 'Microservices', 'Cost Optimization', 'Capacity Planning',
  'Performance Tuning', 'Root Cause Analysis', 'Logging', 'ELK', 'Loki', 'Jaeger',
  'CI/CD Pipeline', 'Automation', 'Infrastructure', 'Cloud Migration', 'Agile', 'Self-Service'
];
const TERM_ALIASES = {
  'Kubernetes': ['k8s'], 'GitHub Actions': ['github actions'], 'GitLab CI': ['gitlab ci', 'gitlab pipelines'],
  'Argo CD': ['argocd', 'argo cd'], 'Infrastructure as Code': ['iac', 'infrastructure-as-code'],
  'Platform Engineering': ['platform engineer'], 'Internal Developer Platform': ['idp'],
  'Site Reliability Engineering': ['site reliability', 'site reliability engineer'],
  'CI/CD': ['ci cd', 'continuous integration and continuous delivery', 'continuous integration/continuous delivery'],
  'SLO': ['slos', 'service level objective', 'service level objectives'],
  'SLI': ['slis', 'service level indicator', 'service level indicators'],
  'SLA': ['slas', 'service level agreement', 'service level agreements'],
  'On-call': ['on call'], 'TCP/IP': ['tcp ip'], 'ELK': ['elk stack'],
  'CI/CD Pipeline': ['cicd pipeline', 'ci cd pipeline', 'ci cd pipelines', 'cicd pipelines'], 'GCP': ['google cloud platform', 'google cloud'],
  'AWS': ['amazon web services'], 'Azure': ['microsoft azure'], 'Continuous Delivery': ['continuous deployment'],
  'High Availability': ['highly available', 'high availability architecture'],
  'Reliability Engineering': ['platform reliability', 'service reliability', 'application uptime', 'system uptime'],
  'Cloud Migration': ['cloud workload migration', 'migrated workloads', 'migrating services', 'workload migration'],
  'Performance Tuning': ['performance optimization', 'improving performance', 'optimized performance'],
  'Security': ['security controls', 'security compliance', 'compliance controls'],
  'Containerization': ['containerized', 'containerisation'],
  'Deployment Automation': ['automated deployment', 'automated deployments', 'deployment process automation']
};

function normalizeForMatch(text) {
  return text.toLowerCase().replace(/&/g, ' and ').replace(/[^a-z0-9+#]+/g, ' ').replace(/\s+/g, ' ').trim();
}

function termMatches(text, term) {
  const normalized = ` ${normalizeForMatch(text)} `;
  const candidates = [term, ...(TERM_ALIASES[term] || [])];
  const variants = candidates.flatMap((candidate) => {
    const phrase = normalizeForMatch(candidate);
    const words = phrase.split(' ');
    const last = words.pop() || '';
    const plural = /[^aeiou]y$/.test(last) ? `${last.slice(0, -1)}ies`
      : /(?:s|x|z|ch|sh)$/.test(last) ? `${last}es` : `${last}s`;
    return [phrase, [...words, plural].join(' ')];
  });
  return variants.some((candidate) => candidate && normalized.includes(` ${candidate} `));
}

const FOCUS_LABELS = { devops: 'DevOps Engineer', sre: 'Site Reliability Engineer', platform: 'Platform Engineer' };
const FOCUS_PRIORITIES = {
  devops: ['CI/CD', 'CI/CD Pipeline', 'Continuous Integration', 'Continuous Delivery', 'Deployment Automation', 'Release Management', 'Terraform', 'Ansible', 'Kubernetes', 'Docker', 'AWS', 'Azure', 'GCP', 'Infrastructure as Code', 'Automation', 'Linux', 'GitHub Actions', 'Jenkins'],
  sre: ['SRE', 'Site Reliability Engineering', 'SLO', 'SLI', 'SLA', 'Incident Response', 'On-call', 'Postmortem', 'Observability', 'Prometheus', 'Grafana', 'Datadog', 'OpenTelemetry', 'High Availability', 'Disaster Recovery', 'Root Cause Analysis', 'Toil Reduction', 'Linux', 'Python'],
  platform: ['Platform Engineering', 'Internal Developer Platform', 'Developer Experience', 'Kubernetes', 'Terraform', 'Helm', 'Argo CD', 'GitOps', 'Self-Service', 'CI/CD', 'Docker', 'Infrastructure as Code', 'Service Mesh', 'OpenShift', 'Automation']
};

function resolveFocus(jobText, selected) {
  if (selected && selected !== 'auto') return selected;
  const text = jobText.toLowerCase();
  if (/platform engineer|platform engineering|internal developer platform/.test(text)) return 'platform';
  if (/site reliability|\bsre\b|reliability engineer/.test(text)) return 'sre';
  return 'devops';
}

function termsFrom(jobText, focus) {
  const priority = FOCUS_PRIORITIES[focus] || [];
  return ROLE_TERMS.filter((term) => termMatches(jobText, term))
    .sort((a, b) => {
      const aRank = priority.indexOf(a);
      const bRank = priority.indexOf(b);
      return (aRank < 0 ? 999 : aRank) - (bRank < 0 ? 999 : bRank);
    }).slice(0, 24);
}

function escapeHTML(value) {
  return value.replace(/[&<>"']/g, (char) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' })[char]);
}

function refreshResumeMatch() {
  const terms = JSON.parse($('#resumeOut').dataset.jobTerms || '[]');
  refreshExperienceFit();
  if (!terms.length) {
    $('#score').textContent = '—';
    $('#scoreSummary').textContent = '—';
    $('#coverageText').textContent = 'No DevOps, SRE, or platform terms found in this JD';
    $('#coverageTextSummary').textContent = 'No role-focused terms found in this job description yet.';
    $('#coverageBar').style.width = '0%';
    $('#coverageBarSummary').style.width = '0%';
    $('.alignment-score').style.setProperty('--coverage', '0%');
    $('#suggestionCount').textContent = '0';
    $('#keywords').innerHTML = '';
    $('#matchSuggestions').innerHTML = '<b>Improvement suggestions</b><p>Add a job description with relevant platform, cloud, automation, or reliability requirements to see targeted suggestions.</p>';
    return;
  }
  const generatedResume = $('#resumeOut').value;
  const matched = terms.filter((term) => termMatches(generatedResume, term));
  const missing = terms.filter((term) => !termMatches(generatedResume, term));
  const score = Math.round(matched.length / terms.length * 100);
  $('#score').textContent = score;
  $('#scoreSummary').textContent = score;
  $('#coverageText').textContent = `${matched.length} of ${terms.length} selected terms found in generated resume`;
  $('#coverageTextSummary').textContent = `${matched.length} of ${terms.length} selected job terms found in your resume`;
  $('#coverageBar').style.width = `${score}%`;
  $('#coverageBarSummary').style.width = `${score}%`;
  $('.alignment-score').style.setProperty('--coverage', `${score}%`);
  $('#suggestionCount').textContent = String(missing.length);
  $('#keywords').innerHTML = terms.map((term) => `<span class="tag ${termMatches(generatedResume, term) ? 'hit' : ''}">${escapeHTML(term)}</span>`).join('');
  const targetHits = Math.ceil(terms.length * 0.9);
  const needed = Math.max(0, targetHits - matched.length);
  const suggestionItems = missing.slice(0, 8).map((term) => `<li><div class="suggestion-term"><b>${escapeHTML(term)}</b><button class="button button-secondary button-small add-keyword" type="button" data-keyword="${escapeHTML(term)}">Add to resume</button></div><span>Add only if this reflects experience you can discuss; place it in Skills, then support it with a real example.</span></li>`).join('');
  const undoAction = lastKeywordUndo ? `<button class="button button-text undo-keyword" type="button">Undo adding ${escapeHTML(lastKeywordUndo.term)}</button>` : '';
  $('#matchSuggestions').innerHTML = needed
    ? `<div class="suggestion-heading"><b>Ways to improve alignment</b><span>About ${needed} more matching ${needed === 1 ? 'term' : 'terms'} to reach 90% coverage</span></div><p>Select a term to add it to Skills. Confirm it reflects your real experience; this estimate is not an ATS guarantee.</p><ul>${suggestionItems}</ul>${undoAction}${missing.length > 8 ? `<small>Showing 8 of ${missing.length} missing terms. Review the remaining terms in red above.</small>` : ''}`
    : `<div class="suggestion-heading"><b>90%+ keyword coverage reached</b></div><p>Review the draft for accuracy and keep every skill and achievement grounded in your experience. This estimate is not an ATS guarantee.</p>${undoAction}`;
}

function refreshExperienceFit() {
  const note = $('#experienceFit');
  const job = $('#jdText').value;
  const resume = $('#resumeText').value;
  const requested = job.match(/\b(\d{1,2})\s*(?:to|[-–—])\s*(\d{1,2})\s*\+?\s*years?\b/i);
  const stated = resume.match(/\b(\d{1,2})\s*years?\b(?:\s*(\d{1,2})\s*months?)?/i);
  if (!requested || !stated) { note.hidden = true; note.textContent = ''; return; }
  const minimum = Math.min(Number(requested[1]), Number(requested[2]));
  const maximum = Math.max(Number(requested[1]), Number(requested[2]));
  const candidateYears = Number(stated[1]) + Number(stated[2] || 0) / 12;
  if (candidateYears >= minimum) { note.hidden = true; note.textContent = ''; return; }
  const candidateDuration = `${stated[1]} year${Number(stated[1]) === 1 ? '' : 's'}${stated[2] ? ` and ${stated[2]} month${Number(stated[2]) === 1 ? '' : 's'}` : ''}`;
  note.textContent = `Experience requirement: this JD asks for ${minimum}–${maximum} years; your source resume states about ${candidateDuration}. Keep your dates accurate; keyword matching cannot replace this experience requirement.`;
  note.hidden = false;
}

function addKeywordToResume(term) {
  const textarea = $('#resumeOut');
  if (!textarea.value.trim() || termMatches(textarea.value, term)) return;
  if (!window.confirm(`Add �${term}� to the Skills section? Only continue if this reflects your real experience.`)) return;
  if (!$('#resumeDocument').hidden) readResumePage();
  const previous = textarea.value;
  const lines = previous.replace(/\r/g, '').split('\n');
  const skillsIndex = lines.findIndex((line) => /^(?:TECHNICAL\s+)?SKILLS$|^CORE COMPETENCIES$/i.test(line.trim()));
  if (skillsIndex >= 0) {
    let insertAt = lines.findIndex((line, index) => index > skillsIndex && /^(?:PROFESSIONAL\s+)?SUMMARY$|^PROFILE$|^(?:PROFESSIONAL\s+|WORK\s+)?EXPERIENCE$|^PROJECTS$|^EDUCATION$|^CERTIFICATIONS?$|^CERTIFICATES$/i.test(line.trim()));
    if (insertAt < 0) insertAt = lines.length;
    lines.splice(insertAt, 0, `� ${term}`);
  } else {
    const insertAt = lines.findIndex((line) => /^(?:PROFESSIONAL\s+)?EXPERIENCE$|^PROJECTS$|^EDUCATION$/i.test(line.trim()));
    const index = insertAt < 0 ? lines.length : insertAt;
    lines.splice(index, 0, 'SKILLS', `� ${term}`, '');
  }
  textarea.value = lines.join('\n').replace(/\n{3,}/g, '\n\n').trim();
  lastKeywordUndo = { before: previous, term };
  resumeTextDirty = true;
  if (!$('#resumeDocument').hidden) setResumeView('page');
  refreshResumeMatch();
  refreshResumeChecks();
  notify(`Added ${term} to Skills. Review the resume for accuracy.`);
  setStatus('Keyword coverage updated. Add a real example if you have one.');
}

$('#matchSuggestions').addEventListener('click', (event) => {
  const addButton = event.target.closest('.add-keyword');
  if (addButton) { addKeywordToResume(addButton.dataset.keyword); return; }
  if (event.target.closest('.undo-keyword') && lastKeywordUndo) {
    if (!$('#resumeDocument').hidden) readResumePage();
    $('#resumeOut').value = lastKeywordUndo.before;
    lastKeywordUndo = null;
    resumeTextDirty = true;
    if (!$('#resumeDocument').hidden) setResumeView('page');
    refreshResumeMatch();
    refreshResumeChecks();
    notify('Keyword addition undone.');
  }
});

function refreshResumeChecks() {
  const text = $('#resumeOut').value;
  if (!text.trim()) { $('#resumeChecks').innerHTML = ''; return; }
  const parsed = parseResumeSections(text);
  const hasContact = /[A-Z0-9._%+-]+@[A-Z0-9.-]+\.[A-Z]{2,}/i.test(text) || /linkedin\.com|github\.com|(?:\+?\d[\d\s().-]{7,}\d)/i.test(text);
  const hasMetric = /\b\d+(?:\.\d+)?\s*(?:%|ms|milliseconds?|seconds?|minutes?|hours?|days?|weeks?|months?|years?|x|k|million|billion)(?![a-z])/i.test(text);
  const hasExperience = parsed.sections.some((section) => ['PROFESSIONAL EXPERIENCE', 'PROJECTS'].includes(section.label));
  const checkRows = [
    { label: 'Contact details', ok: hasContact, hint: hasContact ? 'A contact method is present.' : 'Add an email, phone number, or professional profile link.' },
    { label: 'Measured operational impact', ok: hasMetric, hint: hasMetric ? 'A numeric outcome or scale is present.' : 'Where accurate, quantify reliability, deployment speed, cost, or toil improvements.' },
    { label: 'Experience or project section', ok: hasExperience, hint: hasExperience ? 'Experience or project details are sectioned.' : 'Use a clear experience or projects heading with concise bullets.' }
  ];
  $('#resumeChecks').innerHTML = checkRows.map((row) => `<div class="quality-check ${row.ok ? 'good' : 'needs'}"><span class="check-mark">${row.ok ? '✓' : '!'}</span><div><b>${row.label}</b><small>${row.hint}</small></div><span class="check-state">${row.ok ? 'Detected' : 'Review'}</span></div>`).join('');
}

const RESUME_SECTIONS = [
  { key: 'summary', label: 'PROFESSIONAL SUMMARY', match: /^(professional\s+)?summary$|^profile$|^objective$/i },
  { key: 'experience', label: 'PROFESSIONAL EXPERIENCE', match: /^(work\s+)?(professional\s+)?experience$|^employment(\s+history)?$|^work\s+history$/i },
  { key: 'projects', label: 'PROJECTS', match: /^(selected\s+)?projects$|^personal\s+projects$/i },
  { key: 'skills', label: 'TECHNICAL SKILLS', match: /^(technical\s+)?skills$|^core\s+competencies$|^technologies$|^tools$/i },
  { key: 'certifications', label: 'CERTIFICATIONS', match: /^(certifications|certificates|licenses)(\s+and\s+certifications)?$/i },
  { key: 'education', label: 'EDUCATION', match: /^education(\s+and\s+training)?$/i }
];

function parseResumeSections(resume) {
  const lines = resume.split(/\r?\n/).map((line) => line.trim()).filter(Boolean);
  const starts = [];
  lines.forEach((line, index) => {
    const normalized = line.replace(/[:：]+$/, '').trim();
    const section = RESUME_SECTIONS.find((candidate) => candidate.match.test(normalized))
      || (/^education\s+(?:Jan(?:uary)?|Feb(?:ruary)?|Mar(?:ch)?|Apr(?:il)?|May|Jun(?:e)?|Jul(?:y)?|Aug(?:ust)?|Sep(?:tember)?|Oct(?:ober)?|Nov(?:ember)?|Dec(?:ember)?)\s+20\d{2}$/i.test(normalized)
        ? RESUME_SECTIONS.find((candidate) => candidate.key === 'education')
        : undefined);
    if (section) starts.push({ index, section });
  });
  if (!starts.length) {
    const headerLength = Math.min(2, lines.length);
    return { header: lines.slice(0, headerLength), summary: '', summaryLabel: 'SUMMARY', hasSummary: false, sections: [{ label: 'RESUME DETAILS', sourceLabel: 'RESUME DETAILS', lines: lines.slice(headerLength) }] };
  }
  const header = lines.slice(0, starts[0].index);
  let summary = '';
  let summaryLabel = 'SUMMARY';
  let hasSummary = false;
  const sections = [];
  starts.forEach((start, index) => {
    const end = starts[index + 1]?.index ?? lines.length;
    const content = lines.slice(start.index + 1, end);
    const sourceLabel = lines[start.index].replace(/[:ï¼š]+$/, '').trim();
    if (start.section.key === 'summary') { summary = content.join('\n'); summaryLabel = sourceLabel; hasSummary = true; }
    else if (content.length) sections.push({ label: start.section.label, sourceLabel, lines: content });
  });
  return { header, summary, summaryLabel, hasSummary, sections };
}

function normalizeResumeBullets(text) {
  // Keep the source's bullet characters instead of changing its visual style.
  return text.replace(/\r\n?/g, '\n').replace(/[ \t]+\n/g, '\n').replace(/\n{3,}/g, '\n\n').trim();
}

function extractEmailEvidence(sections, terms) {
  const action = /\b(?:automated|built|implemented|designed|deployed|migrated|reduced|improved|optimized|configured|created|managed|maintained|operated|monitored|scaled|secured|delivered|developed|streamlined|architected|resolved|supported|led|established|integrated|provisioned|orchestrated|hardened|owned|cut|increased|decreased)\b/i;
  return sections
    .filter((section) => ['PROFESSIONAL EXPERIENCE', 'PROJECTS'].includes(section.label))
    .flatMap((section) => section.lines)
    .map((line) => line.replace(/^[-•*\s]+/, '').trim())
    .filter((line) => line.length > 45 && action.test(line) && terms.some((term) => termMatches(line, term)))
    .sort((a, b) => terms.filter((term) => termMatches(b, term)).length - terms.filter((term) => termMatches(a, term)).length)
    .slice(0, 4);
}

function extractContactDetails(resume) {
  const details = [];
  const email = resume.match(/[A-Z0-9._%+-]+@[A-Z0-9.-]+\.[A-Z]{2,}/i)?.[0];
  const phone = resume.match(/(?:\+?\d[\d\s().-]{7,}\d)/)?.[0]?.trim();
  const linkedin = resume.match(/(?:https?:\/\/)?(?:www\.)?linkedin\.com\/[^\s|,;]+/i)?.[0];
  const github = resume.match(/(?:https?:\/\/)?(?:www\.)?github\.com\/[^\s|,;]+/i)?.[0];
  if (email) details.push(email);
  if (phone) details.push(phone);
  if (linkedin) details.push(`LinkedIn: ${linkedin}`);
  if (github) details.push(`GitHub: ${github}`);
  return details;
}

function prioritizeEvidenceBullets(lines, terms) {
  const output = [];
  for (let index = 0; index < lines.length;) {
    if (!/^\s*[-*•●◦▪‣‧�]\s+/.test(lines[index])) { output.push(lines[index]); index += 1; continue; }
    const block = [];
    while (index < lines.length && /^\s*[-*•●◦▪‣‧�]\s+/.test(lines[index])) {
      const line = lines[index++];
      const matches = terms.filter((term) => termMatches(line, term)).length;
      const hasMetric = /\b\d+(?:\.\d+)?\s*(?:%|ms|milliseconds?|seconds?|minutes?|hours?|days?|weeks?|months?|years?|x)\b/i.test(line);
      block.push({ line, rank: matches * 10 + (hasMetric ? 1 : 0) });
    }
    block.sort((a, b) => b.rank - a.rank);
    output.push(...block.map((item) => item.line));
  }
  return output;
}

function buildEvidenceBasedSummary(parsed, focusLabel, relevant, terms) {
  const duration = parsed.summary.match(/\b(\d{1,2})\s*years?\b(?:\s*(\d{1,2})\s*months?)?/i);
  const experience = duration
    ? `${duration[1]} year${Number(duration[1]) === 1 ? '' : 's'}${duration[2] ? ` and ${duration[2]} month${Number(duration[2]) === 1 ? '' : 's'}` : ''} of hands-on experience`
    : 'hands-on experience';
  const skills = relevant.slice(0, 6);
  const evidence = parsed.sections
    .filter((section) => ['PROFESSIONAL EXPERIENCE', 'PROJECTS'].includes(section.label))
    .flatMap((section) => section.lines)
    .filter((line) => /\b\d+(?:\.\d+)?\s*(?:%|ms|milliseconds?|seconds?|minutes?|hours?|days?|weeks?|months?|years?|x)\b/i.test(line))
    .sort((a, b) => terms.filter((term) => termMatches(b, term)).length - terms.filter((term) => termMatches(a, term)).length)
    .slice(0, 1)
    .map((line) => line.replace(/^\s*[-*•●◦▪‣‧�]\s*/, '').trim().slice(0, 110));
  const alignment = skills.length ? `Relevant strengths include ${skills.join(', ')}.` : '';
  const impact = evidence.length ? `Documented impact: ${evidence[0]}` : '';
  const generated = `${focusLabel} with ${experience}, focused on reliable cloud infrastructure and deployment automation. ${alignment} ${impact}`.replace(/\s+/g, ' ').trim();
  return generated.length > 310 || !skills.length ? parsed.summary.trim() : generated;
}

function tailorApplication() {
  const resume = $('#resumeText').value.trim();
  const job = $('#jdText').value.trim();
  if (!resume || !job) { notify('Add your resume and the job description first.'); return; }
  $('#draftSource').textContent = 'Draft source: evidence-based local draft';
  $('#draftSource').dataset.provider = 'local';

  const focus = resolveFocus(job, $('#roleFocus').value);
  const focusLabel = FOCUS_LABELS[focus];
  const terms = termsFrom(job, focus);
  const found = terms.filter((term) => termMatches(resume, term));
  const parsed = parseResumeSections(resume);

  const relevant = found.slice(0, 12);
  const summaryText = parsed.summary
    ? buildEvidenceBasedSummary(parsed, focusLabel, relevant, terms)
    : (relevant.length ? `${focusLabel} strengths documented in this resume include ${relevant.slice(0, 6).join(', ')}.` : 'Summarize your infrastructure, reliability, and automation experience here using details already present in your resume.');
  const tailoredSections = parsed.sections.map((section) => ({
    ...section,
    lines: ['PROFESSIONAL EXPERIENCE', 'PROJECTS'].includes(section.label)
      ? prioritizeEvidenceBullets(section.lines, terms)
      : section.lines
  }));
  const sectionLines = tailoredSections.flatMap((section) => ['', section.sourceLabel || section.label, ...section.lines]);
  const summaryBlock = parsed.hasSummary || summaryText ? ['', parsed.summaryLabel || 'SUMMARY', summaryText] : [];
  const draft = normalizeResumeBullets([...parsed.header, ...summaryBlock, ...sectionLines].join('\n').replace(/\n{3,}/g, '\n\n').trim());
  $('#resumeOut').value = draft;
  resumeTextDirty = true;
  $('#resumeOut').dataset.jobTerms = JSON.stringify(terms);
  refreshResumeMatch();
  refreshResumeChecks();
  setResumeView('page');
  const missingGenerated = terms.filter((term) => !termMatches(draft, term));

  const company = $('#company').value.trim() || '[Company]';
  const name = $('#yourName').value.trim() || '[Your Name]';
  const roleMatch = job.match(/(?:job title|position|role)\s*[:–-]\s*([^\n]+)/i)
    || job.match(/\b((?:(?:junior|associate|senior|staff|lead)\s+)?(?:devops|site reliability|sre|platform|cloud|infrastructure)\s+(?:engineer|specialist|administrator))\b/i);
  const role = roleMatch ? roleMatch[1].trim() : focusLabel;
  currentPacket = { role, company, url: $('#jobUrl').value.trim(), score: Number($('#score').textContent) || 0 };
  const experience = relevant.length ? relevant.slice(0, 4).join(', ') : '[Add relevant skills from your resume]';
  const evidence = extractEmailEvidence(parsed.sections, terms);
  const contacts = extractContactDetails(resume);
  const hiringTeam = company === '[Company]' ? 'the hiring team' : `${company}'s hiring team`;
  const roleTerms = relevant.slice(0, 4);
  const alignment = roleTerms.length ? `The role’s focus on ${roleTerms.join(', ')} aligns with the experience in my resume.` : 'The role aligns with my infrastructure and operations experience.';
  const evidenceBlock = evidence.length
    ? `A few relevant examples:\n${evidence.map((line) => `• ${line}`).join('\n')}`
    : 'I’d be glad to share a specific example of my infrastructure work that matches your team’s priorities.';
  const contactBlock = contacts.length ? contacts.join('\n') : '[Phone] · [LinkedIn]';
  $('#emailOut').value = `Subject: Application: ${role} — ${name}\n\nHi [Hiring Manager’s Name],\n\nI’m reaching out to apply for the ${role} opportunity at ${company}. I’m a ${focusLabel}, and ${alignment}\n\n${evidenceBlock}\n\nI’d welcome a brief conversation about how I could contribute to ${hiringTeam}. My resume is attached for your review.\n\nThank you for your time.\n\nBest regards,\n${name}\n${contactBlock}`;
  const evidenceLines = parsed.sections
    .filter((section) => ['PROFESSIONAL EXPERIENCE', 'PROJECTS'].includes(section.label))
    .flatMap((section) => section.lines)
    .filter((line) => relevant.some((term) => termMatches(line, term)))
    .filter((line) => line.trim().length > 35 && /\b(?:automated|built|implemented|designed|deployed|migrated|reduced|improved|optimized|configured|created|managed|maintained|operated|monitored|scaled|secured|delivered|developed|streamlined|architected|resolved|supported|led|established|integrated|provisioned|orchestrated|hardened)\b/i.test(line))
    .slice(0, 2)
    .map((line) => line.replace(/^[-•*\s]+/, '').trim().slice(0, 320));
  const exampleText = evidenceLines.length
    ? `One relevant example from my resume is: ${evidenceLines[0]}`
    : '';
  const roleNeeds = terms.slice(0, 4).join(', ');
  const coverBackground = relevant.length ? `My resume documents experience with ${experience}.` : 'My resume describes my infrastructure and operations experience in more detail.';
  const greeting = company === '[Company]' ? 'Hiring Manager' : `${company} hiring team`;
  $('#coverLetterOut').value = `Dear ${greeting},\n\nI’m applying for the ${role} position at ${company}. ${coverBackground}\n\n${exampleText ? `${exampleText}\n\n` : ''}I’m interested in the opportunity to contribute to work involving ${roleNeeds || 'reliable infrastructure, automation, and service operations'}. I would welcome a conversation about the team’s priorities and how my background could support them.\n\nThank you for your consideration.\n\nSincerely,\n${name}\n[Email] · [Phone] · [LinkedIn]`;
  const supportedTerms = relevant.slice(0, 4);
  const coverFit = supportedTerms.length
    ? `My experience with ${supportedTerms.join(', ')} aligns with the responsibilities described for this position.`
    : 'My resume outlines my infrastructure and operations background, and I would welcome the chance to discuss its relevance to your team.';
  const coverEvidence = evidenceLines.slice(0, 2).map((line) => `• ${line}`).join('\n');
  const coverParagraphs = [
    `Dear ${greeting},`,
    `I am writing to apply for the ${role} position at ${company}. ${coverFit}`,
    coverEvidence ? `Relevant examples from my experience include:\n\n${coverEvidence}` : 'My resume provides further detail on my infrastructure and operations experience.',
    `I would welcome a conversation about the team’s priorities and how I could contribute. Thank you for your time and consideration.`,
    `Sincerely,\n${name}\n${contacts.length ? contacts.join(' · ') : '[Email] · [Phone] · [LinkedIn]'}`
  ];
  $('#coverLetterOut').value = coverParagraphs.join('\n\n');
  coverLetterTextDirty = true;
  if (!$('#coverLetterDocument').hidden) setCoverLetterView('page');

  $('#results').classList.add('show');
  activateResultTab('resume');
  setStatus(missingGenerated.length ? `${missingGenerated.length} selected terms weren’t found in the generated resume.` : 'Drafts are ready. Review them before applying.');
  $('#results-anchor').scrollIntoView({ behavior: 'smooth', block: 'start' });
}

async function buildApplicationDraftsWithGemini() {
  const resume = $('#resumeText').value.trim();
  const job = $('#jdText').value.trim();
  if (!resume || !job) { notify('Add your resume and the job description first.'); return; }
  const focus = resolveFocus(job, $('#roleFocus').value);
  const targetTerms = termsFrom(job, focus);
  const sourceSupportedTerms = targetTerms.filter((term) => termMatches(resume, term));
  // A text-only miss is not proof that experience is missing. Gemini gets the
  // base resume and evaluates semantic evidence before deciding what to claim.
  const notExactTerms = targetTerms.filter((term) => !sourceSupportedTerms.includes(term));
  const button = $('#analyze');
  button.disabled = true;
  // Build a local packet first so the user still has a usable draft if Gemini
  // is temporarily unavailable or this API project reaches its quota.
  tailorApplication();
  if (!$('#results').classList.contains('show')) { button.disabled = false; return; }
  setStatus('Generating your resume, cover letter, and email with Gemini…');
  try {
    const response = await fetch('/api/generate', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        provider: 'gemini',
        model: GEMINI_MODEL,
        resume,
        jobDescription: job,
        targetTerms,
        sourceSupportedTerms,
        notExactTerms,
        name: $('#yourName').value.trim(),
        company: $('#company').value.trim(),
        role: currentPacket?.role || ''
      })
    });
    const data = await response.json();
    if (!response.ok) throw new Error(data.error || 'AI generation failed.');
    if (typeof data.resume !== 'string' || typeof data.email !== 'string' || typeof data.coverLetter !== 'string') throw new Error('The AI response was incomplete. Please try again.');
    $('#resumeOut').value = normalizeResumeBullets(data.resume);
    resumeTextDirty = true;
    $('#emailOut').value = data.email;
    $('#coverLetterOut').value = data.coverLetter;
    coverLetterTextDirty = true;
    if (!$('#coverLetterDocument').hidden) setCoverLetterView('page');
    setResumeView('page');
    const terms = JSON.parse($('#resumeOut').dataset.jobTerms || '[]');
    $('#resumeOut').dataset.jobTerms = JSON.stringify(terms);
    refreshResumeMatch();
    refreshResumeChecks();
    $('#results').classList.add('show');
    activateResultTab('resume');
    $('#draftSource').textContent = `Draft source: Gemini · ${GEMINI_MODEL}`;
    $('#draftSource').dataset.provider = 'gemini';
    setStatus('Gemini drafts are ready. Review every claim before downloading or sending.');
    $('#results-anchor').scrollIntoView({ behavior: 'smooth', block: 'start' });
  } catch (error) {
    const localConnectionFailed = error instanceof TypeError && /fetch/i.test(error.message);
    const message = localConnectionFailed
      ? 'Could not reach the local AI server. Open OpsReady at http://localhost:8000 and ensure npm start is running.'
      : (error.message || 'Could not reach Gemini.');
    $('#draftSource').textContent = 'Draft source: local fallback (Gemini unavailable)';
    $('#draftSource').dataset.provider = 'local';
    const fallbackMessage = `${message} Your local drafts are still available to review.`;
    setStatus(fallbackMessage);
    notify(fallbackMessage);
  } finally {
    button.disabled = false;
  }
}

$('#analyze').addEventListener('click', buildApplicationDraftsWithGemini);

function validatedJobURL() {
  const value = $('#jobUrl').value.trim();
  if (!value) { notify('Paste a job application link first.'); return null; }
  try {
    const url = new URL(value);
    if (!['https:', 'http:'].includes(url.protocol)) throw new Error('Unsupported protocol');
    return url.href;
  } catch {
    notify('Enter a valid URL starting with http:// or https://.');
    return null;
  }
}

function openJob() {
  const url = validatedJobURL();
  if (url) window.open(url, '_blank', 'noopener,noreferrer');
}

async function copyText(selector) {
  const field = $(selector);
  try {
    await navigator.clipboard.writeText(field.value);
    notify('Copied to clipboard.');
  } catch {
    field.select();
    document.execCommand('copy');
    notify('Copied to clipboard.');
  }
}

$('#openJob').addEventListener('click', openJob);
$('#applyNow').addEventListener('click', openJob);
$('#copyResume').addEventListener('click', () => copyText('#resumeOut'));
$('#copyEmail').addEventListener('click', () => copyText('#emailOut'));
$('#copyCoverLetter').addEventListener('click', () => copyText('#coverLetterOut'));
$('#downloadResume').addEventListener('click', () => {
  const blob = new Blob([$('#resumeOut').value], { type: 'text/plain;charset=utf-8' });
  const link = document.createElement('a');
  link.href = URL.createObjectURL(blob);
  link.download = 'tailored-resume.txt';
  link.click();
  URL.revokeObjectURL(link.href);
});
function createPdfBlob(text, isResume) {
  // Build a small, standards-compliant PDF with built-in Helvetica fonts so
  // exporting does not depend on a CDN, browser print dialog, or server.
  const pages = [[]];
  let pageIndex = 0;
  let y = 744;
  const left = 54;
  const right = 558;
  const bottom = 46;
  const cleanAscii = (value) => value.normalize('NFKD')
    .replace(/[\u0300-\u036f]/g, '')
    .replace(/[•●]/g, '-')
    .replace(/[—–]/g, '-')
    .replace(/[“”]/g, '"')
    .replace(/[’‘]/g, "'")
    .replace(/[·•]/g, ' | ')
    .replace(/[—–]/g, '-')
    .replace(/[“”]/g, '"')
    .replace(/[’‘]/g, "'")
    .replace(/[^\x20-\x7E]/g, ' ')
    .trim();
  const sectionPattern = /^(SUMMARY|PROFESSIONAL SUMMARY|PROFILE|SKILLS|TECHNICAL SKILLS|CORE COMPETENCIES|EXPERIENCE|PROFESSIONAL EXPERIENCE|WORK EXPERIENCE|PROJECTS|EDUCATION|CERTIFICATIONS|CERTIFICATES)$/i;
  const textWidth = (value, size) => value.length * size * 0.49;
  const wrap = (value, maxWidth, size) => {
    const words = value.split(/\s+/);
    const result = [];
    let line = '';
    for (const word of words) {
      if (line && textWidth(`${line} ${word}`, size) > maxWidth) { result.push(line); line = word; }
      else line = line ? `${line} ${word}` : word;
    }
    if (line) result.push(line);
    return result;
  };
  const escapePdf = (value) => value.replace(/\\/g, '\\\\').replace(/\(/g, '\\(').replace(/\)/g, '\\)');
  const addPage = () => { pages.push([]); pageIndex += 1; y = 744; };

  const lines = text.split(/\r?\n/).map(cleanAscii);
  const firstSection = isResume ? lines.findIndex((line) => sectionPattern.test(line)) : -1;
  const headerEnd = firstSection < 0 ? Math.min(4, lines.length) : firstSection;
  const drawLine = (value, size, font, x, color = '0.13 0.17 0.23') => {
    pages[pageIndex].push(`BT /${font} ${size} Tf ${color} rg ${x} ${y} Td (${escapePdf(value)}) Tj ET`);
    y -= size + 5;
  };
  const drawWrapped = (value, size, font, indent = 0) => {
    for (const part of wrap(value, right - left - indent, size)) {
      if (y - size < bottom) addPage();
      drawLine(part, size, font, left + indent);
    }
  };
  if (isResume) {
    lines.slice(0, headerEnd).forEach((line, index) => {
      if (!line) { y -= 3; return; }
      const size = index === 0 ? 17 : (index === 1 ? 10.5 : 8.5);
      const font = index < 2 ? 'F2' : 'F1';
      for (const part of wrap(line, right - left, size)) {
        if (y - size < bottom) addPage();
        drawLine(part, size, font, Math.max(left, (612 - textWidth(part, size)) / 2));
      }
    });
    y -= 8;
  }
  let inProjects = false;
  lines.slice(isResume ? headerEnd : 0).forEach((line) => {
    if (!line) { y -= 6; return; }
    const heading = isResume && sectionPattern.test(line);
    if (heading) {
      if (y - 22 < bottom) addPage();
      y -= 4;
      drawLine(line.toUpperCase(), 10, 'F2', left, '0.16 0.32 0.57');
      pages[pageIndex].push(`0.78 0.83 0.9 RG 0.6 w ${left} ${y + 2} m ${right} ${y + 2} l S`);
      y -= 5;
      inProjects = /^projects$/i.test(line);
      return;
    }
    const bullet = isResume && /^[-*]\s*/.test(line);
    const content = bullet ? `- ${line.replace(/^[-*]\s*/, '')}` : line;
    const projectTitle = isResume && inProjects && !bullet && (/^technologies:/i.test(line) || (line.length < 90 && !/[.!?]$/.test(line)));
    drawWrapped(content, 9.5, projectTitle ? 'F2' : 'F1', bullet ? 11 : 0);
  });

  const objects = [null, '<< /Type /Catalog /Pages 2 0 R >>', '', '<< /Type /Font /Subtype /Type1 /BaseFont /Helvetica /Encoding /WinAnsiEncoding >>', '<< /Type /Font /Subtype /Type1 /BaseFont /Helvetica-Bold /Encoding /WinAnsiEncoding >>'];
  const pageRefs = [];
  pages.forEach((commands, index) => {
    const pageObject = 5 + index * 2;
    const streamObject = pageObject + 1;
    const stream = commands.join('\n');
    pageRefs.push(`${pageObject} 0 R`);
    objects[pageObject] = `<< /Type /Page /Parent 2 0 R /MediaBox [0 0 612 792] /Resources << /Font << /F1 3 0 R /F2 4 0 R >> >> /Contents ${streamObject} 0 R >>`;
    objects[streamObject] = `<< /Length ${stream.length + 1} >>\nstream\n${stream}\nendstream`;
  });
  objects[2] = `<< /Type /Pages /Kids [${pageRefs.join(' ')}] /Count ${pages.length} >>`;

  let output = '%PDF-1.4\n';
  const offsets = [0];
  for (let index = 1; index < objects.length; index += 1) {
    offsets[index] = output.length;
    output += `${index} 0 obj\n${objects[index]}\nendobj\n`;
  }
  const xrefOffset = output.length;
  output += `xref\n0 ${objects.length}\n0000000000 65535 f \n`;
  for (let index = 1; index < objects.length; index += 1) output += `${String(offsets[index]).padStart(10, '0')} 00000 n \n`;
  output += `trailer\n<< /Size ${objects.length} /Root 1 0 R >>\nstartxref\n${xrefOffset}\n%%EOF`;
  return new Blob([new TextEncoder().encode(output)], { type: 'application/pdf' });
}

function downloadBlob(blob, filename) {
  const link = document.createElement('a');
  link.href = URL.createObjectURL(blob);
  link.download = filename;
  link.style.display = 'none';
  document.body.appendChild(link);
  link.click();
  window.setTimeout(() => { URL.revokeObjectURL(link.href); link.remove(); }, 1000);
}

const matchResumeSection = (line) => line.match(/^(SUMMARY|PROFESSIONAL SUMMARY|PROFILE|SKILLS|TECHNICAL SKILLS|CORE COMPETENCIES|EXPERIENCE|PROFESSIONAL EXPERIENCE|WORK EXPERIENCE|PROJECTS|EDUCATION|CERTIFICATIONS|CERTIFICATES)(?:\s+((?:Jan(?:uary)?|Feb(?:ruary)?|Mar(?:ch)?|Apr(?:il)?|May|Jun(?:e)?|Jul(?:y)?|Aug(?:ust)?|Sep(?:tember)?|Oct(?:ober)?|Nov(?:ember)?|Dec(?:ember)?)\s+20\d{2}))?$/i);
function buildResumePage(text) {
  const lines = text.replace(/\r/g, '').split('\n');
  const sectionIndex = lines.findIndex((line) => matchResumeSection(line.trim()));
  const headerEnd = sectionIndex < 0 ? Math.min(4, lines.length) : sectionIndex;
  let section = '';
  const html = lines.map((raw, index) => {
    const line = raw.replace(/\u00a0/g, ' ').replace(/[\t ]+/g, ' ').trim();
    if (!line) return '<div class="resume-line resume-space" data-resume-line="">&nbsp;</div>';
    if (index < headerEnd) return `<div class="resume-line resume-header-line" data-resume-line="header">${escapeHTML(line)}</div>`;
    const headingMatch = matchResumeSection(line);
    if (headingMatch) {
      section = headingMatch[1].toUpperCase();
      const date = headingMatch[2] ? ` <span class="resume-date">${escapeHTML(headingMatch[2])}</span>` : '';
      return `<div class="resume-line resume-section-heading" data-resume-line="heading"><span>${escapeHTML(headingMatch[1])}</span>${date}</div>`;
    }
    const bullet = /^[-*•●–—\uFFFD]\s*/.test(line);
    const content = bullet ? line.replace(/^[-*•●–—\uFFFD]\s*/, '') : line;
    if (bullet && /SKILLS$/.test(section)) {
      const splitAt = content.indexOf(':');
      const value = splitAt > 0
        ? `<b>${escapeHTML(content.slice(0, splitAt + 1))}</b>${escapeHTML(content.slice(splitAt + 1))}`
        : escapeHTML(content);
      return `<div class="resume-line resume-skill-line" data-resume-line="bullet">• ${value}</div>`;
    }
    if (bullet) return `<div class="resume-line resume-bullet" data-resume-line="bullet">• ${escapeHTML(content)}</div>`;
    if (!bullet && /SKILLS$/.test(section)) {
      const splitAt = content.indexOf(':');
      if (splitAt > 0 && splitAt < 55) {
        return `<div class="resume-line resume-skill-category" data-resume-line="copy"><b>${escapeHTML(content.slice(0, splitAt + 1))}</b>${escapeHTML(content.slice(splitAt + 1))}</div>`;
      }
    }
    const isProjectTitle = section === 'PROJECTS' && /^[A-Z0-9]/.test(line) && !/^technologies(?: used)?:/i.test(line) && line.length < 110 && !/[.!?]$/.test(line);
    const isRoleLine = section.includes('EXPERIENCE') && /\b(?:engineer|developer|administrator|specialist|intern)\b/i.test(line) && line.length < 100;
    const isTechLine = section === 'PROJECTS' && /^technologies(?: used)?:/i.test(line);
    const className = isProjectTitle || isRoleLine ? 'resume-entry-title' : isTechLine ? 'resume-tech-line' : 'resume-copy-line';
    const dateMatch = section.includes('EXPERIENCE') && line.match(/^(.*?)\s+((?:Jan(?:uary)?|Feb(?:ruary)?|Mar(?:ch)?|Apr(?:il)?|May|Jun(?:e)?|Jul(?:y)?|Aug(?:ust)?|Sep(?:tember)?|Oct(?:ober)?|Nov(?:ember)?|Dec(?:ember)?)\s+20\d{2}(?:\s*[-–]\s*(?:Present|20\d{2}))?)$/i);
    const extendedDateMatch = section.includes('EXPERIENCE') && !dateMatch && line.match(/^(.*?)\s+((?:Jan(?:uary)?|Feb(?:ruary)?|Mar(?:ch)?|Apr(?:il)?|May|Jun(?:e)?|Jul(?:y)?|Aug(?:ust)?|Sep(?:tember)?|Oct(?:ober)?|Nov(?:ember)?|Dec(?:ember)?)\s+20\d{2}(?:\s*[-\u2013\u2014]{1,2}\s*(?:Present|20\d{2}))?)$/i);
    const alignedDateMatch = dateMatch || extendedDateMatch;
    const dateHTML = alignedDateMatch ? `${escapeHTML(alignedDateMatch[1])} <span class="resume-date">${escapeHTML(alignedDateMatch[2])}</span>` : escapeHTML(line);
    const roleClass = alignedDateMatch ? ' resume-employer-line' : '';
    return `<div class="resume-line ${className}${roleClass}" data-resume-line="${className}">${dateHTML}</div>`;
  }).join('');
  return html;
}

function readResumePage() {
  const paper = $('#resumePaper');
  if (!paper) return;
  const lines = [...paper.children].map((node) => ((node.dataset.resumeLine === 'heading' || node.querySelector('.resume-date')) ? node.textContent : node.innerText).replace(/\u00a0/g, '').replace(/\r/g, ''));
  $('#resumeOut').value = lines.join('\n').replace(/\n{3,}/g, '\n\n').trim();
  resumeTextDirty = false;
  refreshResumeMatch();
  refreshResumeChecks();
}

function setResumeView(view) {
  const isPage = view === 'page';
  $('#resumeOut').hidden = isPage;
  $('#resumeDocument').hidden = !isPage;
  $('#resumeTextTab').classList.toggle('active', !isPage);
  $('#resumePageTab').classList.toggle('active', isPage);
  $('#resumeTextTab').setAttribute('aria-selected', String(!isPage));
  $('#resumePageTab').setAttribute('aria-selected', String(isPage));
  $('#downloadPdf').textContent = isPage ? 'Text view' : 'PDF view';
  if (isPage && resumeTextDirty) {
    $('#resumePaper').innerHTML = buildResumePage($('#resumeOut').value);
    resumeTextDirty = false;
    resumePageCustomized = false;
  }
}

function installResumeDocumentEditor() {
  const textarea = $('#resumeOut');
  const heading = textarea.closest('.resume-panel').querySelector('.result-card-heading');
  const toolbar = document.createElement('div');
  toolbar.className = 'resume-view-tabs';
  heading.querySelector('p').textContent = 'Edit text and layout in the formatted page, then save the same layout as PDF.';
  toolbar.innerHTML = '<div class="resume-view-switch" role="tablist" aria-label="Resume editor mode"><button class="resume-view-tab active" id="resumeTextTab" type="button" role="tab" aria-selected="true">Text</button><button class="resume-view-tab" id="resumePageTab" type="button" role="tab" aria-selected="false">Formatted page</button></div><div class="resume-format-tools" role="toolbar" aria-label="Resume formatting"><button type="button" data-command="bold" title="Bold"><b>B</b></button><button type="button" data-command="italic" title="Italic"><i>I</i></button><button type="button" data-command="underline" title="Underline"><u>U</u></button><select id="resumeTextSize" aria-label="Selected text size" title="Change selected text size"><option value="">Size</option><option>9</option><option>10</option><option>11</option><option>12</option><option>14</option><option>16</option><option>18</option><option>20</option></select><span class="format-divider"></span><button type="button" data-command="justifyLeft" title="Align left">Left</button><button type="button" data-command="justifyCenter" title="Center">Center</button><button type="button" data-command="justifyRight" title="Align right">Right</button><span class="format-divider"></span><button type="button" data-command="undo" title="Undo">Undo</button><button type="button" data-command="redo" title="Redo">Redo</button><button type="button" id="resetResumeLayout" title="Restore the original resume layout">Reset layout</button></div><div class="resume-export-actions"><button class="button button-secondary button-small" id="saveResumePdf" type="button">Print / Save PDF</button></div>';
  const listSpacing = document.createElement('div');
  listSpacing.className = 'resume-list-spacing-tools';
  listSpacing.innerHTML = '<label>List marker<select id="resumeListMarker" aria-label="Selected paragraph bullet style"><option value="bullet">• Round point</option><option value="dash">– Dash</option><option value="none">No marker</option></select></label><label>Spacing<select id="resumeSpacing" aria-label="Resume line spacing"><option value="tight">Compact</option><option value="standard" selected>Standard</option><option value="relaxed">Relaxed</option></select></label>';
  toolbar.append(listSpacing);
  const wrap = document.createElement('div');
  wrap.className = 'resume-document-wrap';
  wrap.id = 'resumeDocument';
  wrap.hidden = true;
  wrap.innerHTML = '<article id="resumePaper" class="resume-paper" contenteditable="true" aria-label="Formatted editable resume" spellcheck="false"></article>';
  heading.after(toolbar);
  textarea.after(wrap);
  $('#resumeTextTab').addEventListener('click', () => setResumeView('text'));
  $('#resumePageTab').addEventListener('click', () => setResumeView('page'));
  $('#downloadPdf').addEventListener('click', () => setResumeView($('#resumeDocument').hidden ? 'page' : 'text'));
  $('#resumePaper').addEventListener('input', () => { resumePageCustomized = true; readResumePage(); });
  $('#saveResumePdf').addEventListener('click', printResumePage);
  let savedSelection = null;
  toolbar.addEventListener('mousedown', (event) => {
    const selection = window.getSelection();
    if (selection?.rangeCount && $('#resumePaper').contains(selection.anchorNode)) savedSelection = selection.getRangeAt(0).cloneRange();
    if (event.target.closest('button')) event.preventDefault();
  });
  const restoreSelection = () => {
    if (!savedSelection) return false;
    const selection = window.getSelection();
    selection.removeAllRanges();
    selection.addRange(savedSelection);
    return true;
  };
  $('#resumeTextSize').addEventListener('change', (event) => {
    if (!restoreSelection()) { notify('Select some resume text first, then choose its size.'); event.target.value = ''; return; }
    const selection = window.getSelection();
    if (!selection.rangeCount || selection.getRangeAt(0).collapsed) { notify('Select some resume text first, then choose its size.'); event.target.value = ''; return; }
    const range = selection.getRangeAt(0);
    const span = document.createElement('span');
    span.style.fontSize = `${Number(event.target.value)}px`;
    span.appendChild(range.extractContents());
    range.insertNode(span);
    selection.removeAllRanges();
    const selected = document.createRange();
    selected.selectNodeContents(span);
    selection.addRange(selected);
    savedSelection = selected.cloneRange();
    resumePageCustomized = true;
    readResumePage();
    event.target.value = '';
  });
  $('#resumeListMarker').addEventListener('change', (event) => {
    restoreSelection();
    const selection = window.getSelection();
    const paper = $('#resumePaper');
    let lines = [];
    if (selection?.rangeCount && paper.contains(selection.anchorNode)) {
      const range = selection.getRangeAt(0);
      lines = [...paper.querySelectorAll('.resume-line:not(.resume-section-heading):not(.resume-header-line):not(.resume-space)')]
        .filter((line) => { try { return range.intersectsNode(line); } catch { return false; } });
      if (!lines.length) {
        let node = selection.anchorNode.nodeType === Node.TEXT_NODE ? selection.anchorNode.parentElement : selection.anchorNode;
        const line = node?.closest('.resume-line');
        if (line && paper.contains(line) && !line.classList.contains('resume-section-heading') && !line.classList.contains('resume-header-line')) lines = [line];
      }
    }
    if (!lines.length) { notify('Place the cursor in or select one or more body lines first.'); event.target.value = 'bullet'; return; }
    const marker = event.target.value === 'bullet' ? '•' : event.target.value === 'dash' ? '–' : '';
    lines.forEach((line) => {
      const value = line.innerText.replace(/\u00a0/g, '').trim().replace(/^[-–—•●*\uFFFD]\s*/, '');
      const isSkill = line.classList.contains('resume-skill-line');
      line.classList.remove('resume-bullet', 'resume-skill-line', 'resume-copy-line');
      if (isSkill) {
        line.classList.add('resume-skill-line');
        const colon = value.indexOf(':');
        line.innerHTML = marker
          ? `${marker} ${colon > 0 ? `<b>${escapeHTML(value.slice(0, colon + 1))}</b>${escapeHTML(value.slice(colon + 1))}` : escapeHTML(value)}`
          : (colon > 0 ? `<b>${escapeHTML(value.slice(0, colon + 1))}</b>${escapeHTML(value.slice(colon + 1))}` : escapeHTML(value));
      } else {
        line.classList.add(marker ? 'resume-bullet' : 'resume-copy-line');
        line.textContent = marker ? `${marker} ${value}` : value;
      }
      line.dataset.resumeLine = marker ? 'bullet' : 'content';
    });
    resumePageCustomized = true;
    readResumePage();
    event.target.value = 'bullet';
  });
  $('#resumeSpacing').addEventListener('change', (event) => {
    $('#resumePaper').dataset.spacing = event.target.value;
    resumePageCustomized = true;
  });
  toolbar.querySelectorAll('[data-command]').forEach((button) => button.addEventListener('click', () => {
    restoreSelection();
    $('#resumePaper').focus();
    document.execCommand(button.dataset.command, false);
    resumePageCustomized = true;
    readResumePage();
  }));
  $('#resetResumeLayout').addEventListener('click', () => {
    $('#resumePaper').innerHTML = buildResumePage($('#resumeOut').value);
    $('#resumePaper').dataset.spacing = 'standard';
    $('#resumeSpacing').value = 'standard';
    resumePageCustomized = false;
    readResumePage();
    notify('Base resume layout restored. Your text is unchanged.');
  });
  $('#resumePaper').addEventListener('keydown', (event) => {
    if (!(event.ctrlKey || event.metaKey)) return;
    const key = event.key.toLowerCase();
    if (key === 'b' || key === 'i' || key === 'u') {
      event.preventDefault();
      document.execCommand(key === 'b' ? 'bold' : key === 'i' ? 'italic' : 'underline', false);
      resumePageCustomized = true;
    }
  });
}

function downloadResumeDocx() {
  if (!$('#resumeDocument').hidden) readResumePage();
  const docx = makeResumeDocx($('#resumeOut').value);
  downloadBlob(docx, 'opsready-tailored-resume.docx');
  notify('Editable Word document downloaded. Open it in Word or a compatible editor.');
}

function makeResumeDocx(text) {
  const scratch = document.createElement('div');
  scratch.innerHTML = buildResumePage(text);
  const xml = (value) => value.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;').replace(/'/g, '&apos;');
  const paragraphs = [...scratch.children].map((node, index) => {
    const kind = node.dataset.resumeLine;
    if (kind === 'space') return '<w:p><w:pPr><w:spacing w:after="80"/></w:pPr></w:p>';
    let style = 'ResumeBody';
    let content;
    let contentIsRuns = false;
    let useRightTab = false;
    if (kind === 'header') {
      style = index === 0 ? 'ResumeName' : index === 1 ? 'ResumeRole' : 'ResumeContact';
      content = xml(node.textContent.trim());
    } else if (kind === 'heading') {
      style = 'ResumeHeading';
      const spans = node.querySelectorAll('span');
      content = xml(spans[0]?.textContent.trim() || node.textContent.trim());
      if (spans[1]) { content = `<w:r><w:t>${content}</w:t></w:r><w:r><w:tab/></w:r><w:r><w:t>${xml(spans[1].textContent.trim())}</w:t></w:r>`; contentIsRuns = true; useRightTab = true; }
    } else if (kind === 'bullet') {
      style = 'ResumeBullet';
      content = xml(node.innerText.replace(/\u00a0/g, '').replace(/\s+/g, ' ').trim());
    } else if (node.classList.contains('resume-entry-title')) {
      style = 'ResumeEntry';
      if (node.querySelector('.resume-date')) {
        const date = node.querySelector('.resume-date').textContent.trim();
        content = `<w:r><w:t>${xml(node.childNodes[0].textContent.trim())}</w:t></w:r><w:r><w:tab/></w:r><w:r><w:t>${xml(date)}</w:t></w:r>`;
        contentIsRuns = true; useRightTab = true;
      } else content = xml(node.textContent.trim());
    } else if (node.classList.contains('resume-employer-line')) {
      style = 'ResumeBody';
      content = `<w:r><w:t>${xml(node.childNodes[0].textContent.trim())}</w:t></w:r><w:r><w:tab/></w:r><w:r><w:t>${xml(node.querySelector('.resume-date').textContent.trim())}</w:t></w:r>`;
      contentIsRuns = true; useRightTab = true;
    } else content = xml(node.innerText.replace(/\u00a0/g, '').trim());
    if (!contentIsRuns) content = `<w:r><w:t xml:space="preserve">${content}</w:t></w:r>`;
    const tabs = useRightTab ? '<w:tabs><w:tab w:val="right" w:pos="9360"/></w:tabs>' : '';
    return `<w:p><w:pPr><w:pStyle w:val="${style}"/>${tabs}</w:pPr>${content || '<w:r><w:t></w:t></w:r>'}</w:p>`;
  }).join('');
  const files = {
    '[Content_Types].xml': '<?xml version="1.0" encoding="UTF-8" standalone="yes"?><Types xmlns="http://schemas.openxmlformats.org/package/2006/content-types"><Default Extension="rels" ContentType="application/vnd.openxmlformats-package.relationships+xml"/><Default Extension="xml" ContentType="application/xml"/><Override PartName="/word/document.xml" ContentType="application/vnd.openxmlformats-officedocument.wordprocessingml.document.main+xml"/><Override PartName="/word/styles.xml" ContentType="application/vnd.openxmlformats-officedocument.wordprocessingml.styles+xml"/></Types>',
    '_rels/.rels': '<?xml version="1.0" encoding="UTF-8" standalone="yes"?><Relationships xmlns="http://schemas.openxmlformats.org/package/2006/relationships"><Relationship Id="rId1" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/officeDocument" Target="word/document.xml"/></Relationships>',
    'word/_rels/document.xml.rels': '<?xml version="1.0" encoding="UTF-8" standalone="yes"?><Relationships xmlns="http://schemas.openxmlformats.org/package/2006/relationships"><Relationship Id="rId1" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/styles" Target="styles.xml"/></Relationships>',
    'word/styles.xml': '<?xml version="1.0" encoding="UTF-8" standalone="yes"?><w:styles xmlns:w="http://schemas.openxmlformats.org/wordprocessingml/2006/main"><w:docDefaults><w:rPrDefault><w:rPr><w:rFonts w:ascii="Arial" w:hAnsi="Arial"/><w:sz w:val="19"/></w:rPr></w:rPrDefault><w:pPrDefault><w:pPr><w:spacing w:after="70" w:line="250" w:lineRule="auto"/></w:pPr></w:pPrDefault></w:docDefaults><w:style w:type="paragraph" w:default="1" w:styleId="ResumeBody"><w:name w:val="Resume Body"/></w:style><w:style w:type="paragraph" w:styleId="ResumeName"><w:name w:val="Resume Name"/><w:pPr><w:jc w:val="center"/><w:spacing w:after="40"/></w:pPr><w:rPr><w:b/><w:sz w:val="30"/><w:color w:val="202A39"/></w:rPr></w:style><w:style w:type="paragraph" w:styleId="ResumeRole"><w:name w:val="Resume Role"/><w:pPr><w:jc w:val="center"/></w:pPr><w:rPr><w:b/><w:sz w:val="22"/></w:rPr></w:style><w:style w:type="paragraph" w:styleId="ResumeContact"><w:name w:val="Resume Contact"/><w:pPr><w:jc w:val="center"/></w:pPr><w:rPr><w:sz w:val="17"/></w:rPr></w:style><w:style w:type="paragraph" w:styleId="ResumeHeading"><w:name w:val="Resume Heading"/><w:pPr><w:keepNext/><w:spacing w:before="210" w:after="80"/><w:pBdr><w:bottom w:val="single" w:sz="4" w:space="2" w:color="BCC7D6"/></w:pBdr></w:pPr><w:rPr><w:b/><w:sz w:val="21"/><w:color w:val="20364F"/></w:rPr></w:style><w:style w:type="paragraph" w:styleId="ResumeEntry"><w:name w:val="Resume Entry"/><w:pPr><w:keepNext/><w:spacing w:before="100"/></w:pPr><w:rPr><w:b/></w:rPr></w:style><w:style w:type="paragraph" w:styleId="ResumeBullet"><w:name w:val="Resume Bullet"/><w:pPr><w:ind w:left="360" w:hanging="220"/></w:pPr></w:style></w:styles>',
    'word/document.xml': `<?xml version="1.0" encoding="UTF-8" standalone="yes"?><w:document xmlns:w="http://schemas.openxmlformats.org/wordprocessingml/2006/main"><w:body>${paragraphs}<w:sectPr><w:pgSz w:w="11906" w:h="16838"/><w:pgMar w:top="850" w:right="1000" w:bottom="850" w:left="1000" w:header="425" w:footer="425" w:gutter="0"/></w:sectPr></w:body></w:document>`
  };
  return new Blob([zipStoredFiles(files)], { type: 'application/vnd.openxmlformats-officedocument.wordprocessingml.document' });
}

function zipStoredFiles(files) {
  const encoder = new TextEncoder();
  const crcTable = new Uint32Array(256);
  for (let n = 0; n < 256; n += 1) {
    let c = n;
    for (let k = 0; k < 8; k += 1) c = c & 1 ? 0xedb88320 ^ (c >>> 1) : c >>> 1;
    crcTable[n] = c >>> 0;
  }
  const crc32 = (bytes) => {
    let crc = 0xffffffff;
    for (const byte of bytes) crc = crcTable[(crc ^ byte) & 0xff] ^ (crc >>> 8);
    return (crc ^ 0xffffffff) >>> 0;
  };
  const chunks = [];
  const central = [];
  let offset = 0;
  const pushHeader = (length, write) => { const bytes = new Uint8Array(length); write(new DataView(bytes.buffer)); chunks.push(bytes); return bytes; };
  const write16 = (view, at, value) => view.setUint16(at, value, true);
  const write32 = (view, at, value) => view.setUint32(at, value, true);
  const names = Object.entries(files);
  for (const [name, content] of names) {
    const nameBytes = encoder.encode(name);
    const data = encoder.encode(content);
    const crc = crc32(data);
    const local = pushHeader(30, (v) => { write32(v,0,0x04034b50);write16(v,4,20);write16(v,6,0x0800);write16(v,8,0);write16(v,10,0);write16(v,12,0x21);write32(v,14,crc);write32(v,18,data.length);write32(v,22,data.length);write16(v,26,nameBytes.length);write16(v,28,0); });
    chunks.push(nameBytes, data);
    const directory = pushHeader(46, (v) => { write32(v,0,0x02014b50);write16(v,4,20);write16(v,6,20);write16(v,8,0x0800);write16(v,10,0);write16(v,12,0);write16(v,14,0x21);write32(v,16,crc);write32(v,20,data.length);write32(v,24,data.length);write16(v,28,nameBytes.length);write16(v,30,0);write16(v,32,0);write16(v,34,0);write16(v,36,0);write32(v,38,0);write32(v,42,offset); });
    central.push(directory, nameBytes);
    offset += local.length + nameBytes.length + data.length;
  }
  const centralOffset = offset;
  const centralSize = central.reduce((sum, item) => sum + item.length, 0);
  chunks.push(...central);
  const end = pushHeader(22, (v) => { write32(v,0,0x06054b50);write16(v,4,0);write16(v,6,0);write16(v,8,names.length);write16(v,10,names.length);write32(v,12,centralSize);write32(v,16,centralOffset);write16(v,20,0); });
  chunks.push(end);
  return new Blob(chunks, { type: 'application/zip' });
}

function printResumePage() {
  const editingFormattedPage = !$('#resumeDocument').hidden;
  if (editingFormattedPage) readResumePage();
  setStatus('Choose Save as PDF in the print dialog to export your formatted resume.');
  const printFrame = document.createElement('iframe');
  printFrame.className = 'resume-print-frame';
  document.body.appendChild(printFrame);
  const page = printFrame.contentDocument;
  const printableMarkup = editingFormattedPage || (resumePageCustomized && !resumeTextDirty)
    ? $('#resumePaper').innerHTML
    : buildResumePage($('#resumeOut').value);
  page.open();
  page.write(`<!doctype html><html><head><meta charset="utf-8"><title>Tailored resume</title><style>${resumePrintStyles()}</style></head><body><main class="resume-paper">${printableMarkup}</main><script>window.onload=()=>{window.focus();window.print();};window.onafterprint=()=>window.parent.postMessage('opsready-print-done','*');<\/script></body></html>`);
  page.querySelector('main').dataset.spacing = $('#resumePaper').dataset.spacing || 'standard';
  page.close();
  window.addEventListener('message', function removePrintFrame(event) {
    if (event.data !== 'opsready-print-done') return;
    printFrame.remove();
    window.removeEventListener('message', removePrintFrame);
  });
}

function resumePrintStyles() {
  return `
    @page { size: A4; margin: 0; }
    * { box-sizing: border-box; }
    html, body { margin: 0; padding: 0; width: auto; min-height: 0; background: #fff; color: #202a39; font: 9.5pt Arial, Helvetica, sans-serif; }
    .resume-paper { width: auto; min-height: 0; margin: 0; padding: 14mm 16mm; background: #fff; color: #202a39; box-shadow: none; line-height: 1.27; letter-spacing: normal; word-spacing: normal; text-align: left; orphans: 2; widows: 2; }
    .resume-line { white-space: normal; overflow-wrap: break-word; word-break: normal; letter-spacing: normal; word-spacing: normal; }
    .resume-space { height: 5pt; line-height: 0; font-size: 0; }
    .resume-header-line { text-align: center; line-height: 1.3; }
    .resume-header-line:first-child { font-size: 16pt; font-weight: 700; letter-spacing: .1pt; }
    .resume-header-line:nth-child(2) { margin-top: 2pt; font-size: 10.5pt; font-weight: 600; }
    .resume-header-line:nth-child(n+3) { font-size: 8.5pt; }
    .resume-header-line:last-of-type { margin-bottom: 10pt; }
    .resume-section-heading { display: flex; justify-content: space-between; align-items: baseline; margin: 10pt 0 4pt; padding-bottom: 2pt; border-bottom: 1px solid #777; font-size: 10.5pt; font-weight: 700; font-variant: small-caps; letter-spacing: .1pt; break-after: avoid; page-break-after: avoid; }
    .resume-date { white-space: nowrap; }
    .resume-entry-title { margin: 5pt 0 1pt; font-weight: 700; break-after: avoid; page-break-after: avoid; }
    .resume-employer-line { display: flex; justify-content: space-between; gap: 8pt; font-weight: 700; break-after: avoid; page-break-after: avoid; }
    .resume-copy-line { margin: 1pt 0; }
    .resume-bullet, .resume-skill-line { display: block; margin: 1.5pt 0; padding-left: 13pt; text-indent: -8pt; }
    .resume-skill-category { margin: 1.5pt 0; padding: 0; }
    .resume-bullet:before, .resume-skill-line:before { content: none; }
    .resume-tech-line { margin: 2pt 0; font-size: 9pt; }
    .resume-paper[data-spacing="tight"] { line-height: 1.18; }
    .resume-paper[data-spacing="tight"] .resume-space { height: 0; }
    .resume-paper[data-spacing="tight"] .resume-bullet, .resume-paper[data-spacing="tight"] .resume-skill-line { margin: 0; }
    .resume-paper[data-spacing="relaxed"] { line-height: 1.45; }
    .resume-paper[data-spacing="relaxed"] .resume-space { height: 8pt; }
    .resume-paper[data-spacing="relaxed"] .resume-bullet, .resume-paper[data-spacing="relaxed"] .resume-skill-line { margin: 3pt 0; }
    @media print { html, body { width: auto; } .resume-paper { margin: 0; box-shadow: none; } }
  `;
}

let coverLetterTextDirty = true;

function buildCoverLetterPage(text) {
  return text.replace(/\r/g, '').split('\n').map((line) => line.trim()
    ? `<p class="cover-letter-paragraph">${escapeHTML(line)}</p>`
    : '<p class="cover-letter-space" data-letter-space="true"><br></p>').join('');
}

function readCoverLetterPage() {
  const paper = $('#coverLetterPaper');
  if (!paper) return;
  $('#coverLetterOut').value = [...paper.children].map((node) => node.dataset.letterSpace ? '' : node.innerText.trimEnd()).join('\n').replace(/\n{3,}/g, '\n\n').trim();
  coverLetterTextDirty = false;
}

function setCoverLetterView(view) {
  const isPage = view === 'page';
  if (!isPage && !$('#coverLetterDocument').hidden) readCoverLetterPage();
  if (isPage && coverLetterTextDirty) {
    $('#coverLetterPaper').innerHTML = buildCoverLetterPage($('#coverLetterOut').value);
    coverLetterTextDirty = false;
  }
  $('#coverLetterOut').hidden = isPage;
  $('#coverLetterDocument').hidden = !isPage;
  $('#coverTextTab').classList.toggle('active', !isPage);
  $('#coverPageTab').classList.toggle('active', isPage);
  $('#coverTextTab').setAttribute('aria-selected', String(!isPage));
  $('#coverPageTab').setAttribute('aria-selected', String(isPage));
}

function installCoverLetterEditor() {
  const textarea = $('#coverLetterOut');
  const heading = textarea.closest('article').querySelector('.result-card-heading');
  textarea.closest('article').querySelector('#downloadCoverLetter')?.remove();
  const toolbar = document.createElement('div');
  toolbar.className = 'cover-letter-toolbar';
  toolbar.innerHTML = '<div class="resume-view-switch" role="tablist" aria-label="Cover letter editor mode"><button class="resume-view-tab active" id="coverTextTab" type="button" role="tab" aria-selected="true">Text</button><button class="resume-view-tab" id="coverPageTab" type="button" role="tab" aria-selected="false">Formatted page</button></div><button class="button button-secondary button-small" id="downloadCoverLetter" type="button">Print / Save PDF</button>';
  const documentWrap = document.createElement('div');
  documentWrap.className = 'cover-letter-document-wrap';
  documentWrap.id = 'coverLetterDocument';
  documentWrap.hidden = true;
  documentWrap.innerHTML = '<article id="coverLetterPaper" class="cover-letter-paper" contenteditable="true" aria-label="Formatted editable cover letter" spellcheck="false"></article>';
  heading.after(toolbar);
  textarea.after(documentWrap);
  toolbar.querySelector('#coverTextTab').addEventListener('click', () => setCoverLetterView('text'));
  toolbar.querySelector('#coverPageTab').addEventListener('click', () => setCoverLetterView('page'));
  textarea.addEventListener('input', () => { coverLetterTextDirty = true; });
  documentWrap.querySelector('#coverLetterPaper').addEventListener('input', () => { readCoverLetterPage(); });
  toolbar.querySelector('#downloadCoverLetter').addEventListener('click', printCoverLetterPage);
}

function printCoverLetterPage() {
  if (!$('#coverLetterDocument').hidden) readCoverLetterPage();
  const text = $('#coverLetterOut').value.trim();
  if (!text) { notify('Build the cover letter first.'); return; }
  const markup = !$('#coverLetterDocument').hidden
    ? $('#coverLetterPaper').innerHTML
    : buildCoverLetterPage(text);
  setStatus('Choose Save as PDF in the print dialog to export your cover letter.');
  const printFrame = document.createElement('iframe');
  printFrame.className = 'resume-print-frame';
  document.body.appendChild(printFrame);
  const page = printFrame.contentDocument;
  const styles = '@page{size:A4;margin:0}*{box-sizing:border-box}html,body{margin:0;padding:0;background:#fff;color:#202a39;font:11pt Arial,Helvetica,sans-serif}.cover-letter-paper{min-height:0;margin:0;padding:24mm 25mm;background:#fff;color:#202a39;line-height:1.55;white-space:normal;overflow-wrap:anywhere}.cover-letter-paragraph{margin:0 0 13pt}.cover-letter-space{height:9pt;margin:0}.cover-letter-space br{display:none}@media print{.cover-letter-paper{margin:0;box-shadow:none}}';
  page.open();
  page.write(`<!doctype html><html><head><meta charset="utf-8"><title>Cover letter</title><style>${styles}</style></head><body><main class="cover-letter-paper">${markup}</main><script>window.onload=()=>{window.focus();window.print();};window.onafterprint=()=>window.parent.postMessage('opsready-print-done','*');<\/script></body></html>`);
  page.close();
  window.addEventListener('message', function removeCoverPrintFrame(event) {
    if (event.data !== 'opsready-print-done') return;
    printFrame.remove();
    window.removeEventListener('message', removeCoverPrintFrame);
  });
}

function installJobLinkImporter() {
  const input = $('#jobUrl');
  const label = document.querySelector('label[for="jobUrl"]');
  const jobArticle = label.closest('article');
  const oldRow = input.parentElement;
  const jdCard = $('#jdFile').closest('article');
  const importRow = document.createElement('div');
  importRow.className = 'inline-field jd-import-field';
  const button = document.createElement('button');
  button.className = 'button button-secondary';
  button.id = 'fetchJD';
  button.type = 'button';
  button.textContent = 'Import JD';
  const status = document.createElement('p');
  status.className = 'jd-fetch-status';
  status.id = 'jdFetchStatus';
  status.setAttribute('aria-live', 'polite');
  status.textContent = 'Some job boards block automated import; paste or upload the JD if needed.';
  input.placeholder = 'https://company.com/careers/platform-engineer';
  oldRow.insertBefore(button, oldRow.querySelector('#openJob'));
  importRow.append(input, button);
  label.textContent = 'Public job posting link';
  jdCard.querySelector('.panel-heading').after(label, importRow, status);
  jobArticle.querySelector('h3').textContent = 'Application destination';
  jobArticle.querySelector('.panel-heading p').textContent = 'Use the posting link above to open the employer’s application page.';
  button.addEventListener('click', importJobDescription);
}

async function importJobDescription() {
  const url = validatedJobURL();
  if (!url) return;
  const button = $('#fetchJD');
  const status = $('#jdFetchStatus');
  button.disabled = true;
  button.textContent = 'Importing…';
  status.textContent = 'Reading the job page…';
  status.dataset.state = 'loading';
  try {
    const response = await fetch('/api/fetch-job', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ url }) });
    const result = await response.json();
    if (!response.ok) throw new Error(result.error || 'Could not import this job page.');
    $('#jdText').value = result.text;
    $('#jdName').textContent = `Imported job description from ${result.source}`;
    status.textContent = `Imported ${result.text.trim().split(/\s+/).length.toLocaleString()} words. Review the extracted text before tailoring your resume.`;
    status.dataset.state = 'ready';
    setStatus('Job description imported. Review it, then build your application drafts.');
  } catch (error) {
    status.textContent = error.message || 'Could not import this job page. Paste the JD or upload it instead.';
    status.dataset.state = 'error';
    setStatus('Job description import needs attention.');
  } finally {
    button.disabled = false;
    button.textContent = 'Import JD';
  }
}

installResumeDocumentEditor();
installCoverLetterEditor();
installJobLinkImporter();

$('#downloadPdf').addEventListener('click', async () => {
  return;
  const text = $('#resumeOut').value.trim();
  if (!text) { notify('Build the resume draft first.'); return; }
  try {
    setStatus('Preparing resume PDF…');
    resumePreviewBlob = createPdfBlob(text, true);
    if (resumePreviewUrl) URL.revokeObjectURL(resumePreviewUrl);
    resumePreviewUrl = URL.createObjectURL(resumePreviewBlob);
    $('#resumePdfFrame').src = resumePreviewUrl;
    $('#resumePdfDialog').showModal();
    setStatus('Resume PDF preview ready.');
  } catch (error) {
    console.error(error);
    setStatus('Could not create the PDF. Please try again.');
    notify('PDF export failed. Try again or download the text version.');
  }
});

$('#downloadPreviewPdf').addEventListener('click', () => {
  if (resumePreviewBlob) downloadBlob(resumePreviewBlob, 'opsready-tailored-resume.pdf');
});
$('#closeResumePreview').addEventListener('click', () => $('#resumePdfDialog').close());
$('#resumePdfDialog').addEventListener('close', () => {
  $('#resumePdfFrame').src = 'about:blank';
  if (resumePreviewUrl) URL.revokeObjectURL(resumePreviewUrl);
  resumePreviewUrl = null;
  resumePreviewBlob = null;
});

$('#downloadCoverLetter').addEventListener('click', async () => {
  return;
  const text = $('#coverLetterOut').value.trim();
  if (!text) { notify('Build your application packet first.'); return; }
  try {
    setStatus('Preparing cover letter PDF…');
    downloadBlob(createPdfBlob(text, false), 'opsready-cover-letter.pdf');
    setStatus('Cover letter PDF downloaded. Review it before sending.');
  } catch (error) {
    console.error(error);
    setStatus('Could not create the PDF. Please try again.');
    notify('Cover letter PDF export failed. Try again.');
  }
});
$('#mailto').addEventListener('click', () => {
  const draft = $('#emailOut').value.trim();
  if (!draft) { notify('Build or write an email draft first.'); return; }
  const lines = draft.split(/\r?\n/);
  const subjectIndex = lines.findIndex((line) => /^Subject:\s*/i.test(line));
  const subject = subjectIndex >= 0 ? lines[subjectIndex].replace(/^Subject:\s*/i, '').trim() : 'DevOps role application';
  const body = lines.filter((_, index) => index !== subjectIndex).join('\n').replace(/^\s+/, '');
  const composeUrl = new URL('https://mail.google.com/mail/u/0/');
  composeUrl.searchParams.set('view', 'cm');
  composeUrl.searchParams.set('fs', '1');
  composeUrl.searchParams.set('to', '');
  composeUrl.searchParams.set('su', subject);
  composeUrl.searchParams.set('body', body);
  const composeWindow = window.open(composeUrl.toString(), '_blank');
  if (!composeWindow) notify('Allow pop-ups for localhost to open the Gmail draft.');
});
$('#clear').addEventListener('click', () => {
  currentPacket = null;
  for (const id of ['resumeText', 'jdText', 'jobUrl', 'yourName', 'company', 'resumeName', 'jdName', 'resumeOut', 'emailOut', 'coverLetterOut']) $(`#${id}`).value = '';
  $('#resumeFile').value = '';
  $('#jdFile').value = '';
  $('#resumeOut').dataset.jobTerms = '[]';
  $('#results').classList.remove('show');
  setStatus('Ready when you are');
  window.scrollTo({ top: 0, behavior: 'smooth' });
});
$('#resumeOut').addEventListener('input', () => { lastKeywordUndo = null; resumeTextDirty = true; refreshResumeMatch(); refreshResumeChecks(); });

function activateResultTab(name) {
  document.querySelectorAll('[data-result-tab]').forEach((tab) => {
    const active = tab.dataset.resultTab === name;
    tab.classList.toggle('active', active);
    tab.setAttribute('aria-selected', String(active));
  });
  document.querySelectorAll('[data-result-pane]').forEach((pane) => {
    const active = pane.dataset.resultPane === name;
    pane.hidden = !active;
    pane.classList.toggle('active', active);
  });
}

document.querySelector('.result-tabs').addEventListener('click', (event) => {
  const tab = event.target.closest('[data-result-tab]');
  if (tab) activateResultTab(tab.dataset.resultTab);
});

document.querySelector('.side-link[href="#email-card"]').addEventListener('click', (event) => {
  event.preventDefault();
  activateResultTab('email');
  $('#results').scrollIntoView({ behavior: 'smooth', block: 'start' });
});

const themeSelect = $('#themeSelect');
let savedTheme = 'system';
try { savedTheme = localStorage.getItem('roleready-theme') || 'system'; } catch { /* Storage can be unavailable in private browsing. */ }
if (!['light', 'dark', 'system'].includes(savedTheme)) savedTheme = 'system';
document.documentElement.dataset.theme = savedTheme;
themeSelect.value = savedTheme;
themeSelect.addEventListener('change', () => {
  const theme = themeSelect.value;
  document.documentElement.dataset.theme = theme;
  try { localStorage.setItem('roleready-theme', theme); } catch { /* Theme still applies for this page session. */ }
});
