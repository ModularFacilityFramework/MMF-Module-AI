// What the AI can and cannot do, at a glance, for Setup -> Tools and Skills.
// Status: tested (built, and tried with real questions on the AI server),
// done (built, not yet tried in real answers), planned (not built). The
// planned list comes from the user's goal for this module. Keep it honest:
// change a status only when the work is really built or tested.
const TOOLS = [
  { name: 'Date and time, calculator, unit converter', status: 'tested', note: 'Tools below; tested 24/11/2026.' },
  { name: 'Read uploaded files and images', status: 'tested', note: 'PDF, Word, Excel, PowerPoint, text and code; images with models that see images (Qwen, Mistral).' },
  { name: 'Look up parts of long attached files', status: 'tested', note: 'Tool "Read attached file".' },
  { name: 'Edit Word and Excel files, make new files', status: 'tested', note: 'The original is never changed.' },
  { name: 'Skills (load_skill, read_skill_file)', status: 'tested', note: 'Setup -> Skills; tested 26/11/2026.' },
  { name: 'Safety: guard model, scope check, output scan, audience', status: 'tested', note: 'Setup -> Safety; tested 26/11/2026.' },
  { name: 'MCP servers: tools from other services', status: 'tested', note: 'Setup -> Tools, MCP servers; each MCP tool is installed, given an audience, read by the guard and logged like any tool; tested 27/11/2026.' },
  { name: 'PDB: official PDBe MCP servers (EMBL-EBI): PDBe API and PDBe Search', status: 'tested', note: 'pdbe-mcp-server 2.0.1 on the backend host (127.0.0.1); tested 27/11/2026.' },
  { name: 'Literature and bio databases: BioMCP (PubMed, Europe PMC, PubTator3, UniProt, InterPro, STRING, PDB, AlphaFold, ...)', status: 'tested', note: 'biomcp-cli 0.9.3 (MIT) on the backend host (127.0.0.1); tested 27/11/2026.' },
  { name: 'gemmi: read MTZ, mmCIF and PDB files', status: 'planned', note: 'As a direct tool, and inside the code sandbox.' },
  { name: 'OCR: scanned PDFs and photos of documents to text', status: 'planned', note: '' },
  { name: 'Code sandbox: Python with numpy, scipy, pandas, matplotlib, biopython, gemmi, rdkit; charts in the chat', status: 'planned', note: 'Isolated: no network, no access to user files except what the chat hands in, CPU, memory and time limits.' },
  { name: 'Speech to text (Whisper) with a microphone button', status: 'planned', note: 'On the AI server next to the model, if memory allows.' },
  { name: 'MFF docs: index, search and read', status: 'tested', note: 'Tools below (MFF docs); tested 26/11/2026. The AI looks there first for questions about MFF, a module or a procedure. Which doc is for whom: INDEX.json in the docs, else user guides for everyone and the rest for developers.' },
  { name: 'My projects in MFF: bookings, samples, data, jobs', status: 'planned', note: 'Own projects only; the project and its members in core decide.' },
  { name: 'Finance: how charges are calculated and the current recovery rates', status: 'planned', note: 'Details (companies, costs, invoices) only for facility staff and developers.' },
  { name: 'Read files from my projects', status: 'planned', note: 'Through core, with the project-membership check in the backend.' },
  { name: 'Slurm: queue, job state, node state', status: 'done', note: 'Tools below (Slurm), through the slurm module\'s read-only routes: own jobs for users, all jobs and nodes for staff and developers.' },
  { name: 'cryoSPARC: job status and recent log lines', status: 'planned', note: 'Read-only, through the cryoem module.' },
  { name: 'Server status', status: 'planned', note: 'Developers and administrators only.' },
  { name: 'ChimeraX figures', status: 'planned', note: '' },
  { name: 'Agentic Coot', status: 'planned', note: 'Coot already has many skills of its own.' },
  { name: 'Read databases (MFF MariaDB, MSSQL): read-only, developers only', status: 'planned', note: 'Waits for dedicated read-only accounts from the user.' },
  { name: 'Web search and reading web pages', status: 'tested', note: 'Tools below (Web); tested 27/11/2026; through the facility\'s own SearXNG; public pages only; the guard reads search words and pages; the AI cites its URLs. Approved by the user 27/11/2026.' }
];

const PLANNED_SKILLS = [
  { name: 'Materials and methods (MX and cryo-EM)', status: 'planned', note: 'Writing the methods section from what was done at the facility.' },
  { name: 'Paper writing', status: 'planned', note: '' },
  { name: 'Grant writing', status: 'planned', note: '' },
  { name: 'ChimeraX figures', status: 'planned', note: 'With the ChimeraX tool.' },
  { name: 'Model building with Coot', status: 'planned', note: 'With the agentic Coot tool.' }
];

// The skills that exist: tested once one was loaded in a real answer.
async function skills(pool) {
  const rows = await pool.query(
    `SELECT s.name, s.enabled, COUNT(l.id) AS loads, MAX(l.created_at) AS last_used
       FROM ai_skills s LEFT JOIN ai_skill_log l ON l.skill = s.name GROUP BY s.id, s.name, s.enabled ORDER BY s.name`
  );
  const made = rows.map(r => ({
    name: r.name,
    status: Number(r.loads) > 0 ? 'tested' : 'done',
    note: `${r.enabled ? 'On' : 'Off'}; ${Number(r.loads) > 0 ? `loaded in ${Number(r.loads)} answers, last ${new Date(r.last_used).toLocaleDateString('en-GB')}` : 'not loaded in a real answer yet'}.`
  }));
  return [...made, ...PLANNED_SKILLS];
}

module.exports = { TOOLS, PLANNED_SKILLS, skills };
