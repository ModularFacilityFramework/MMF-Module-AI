// Tools that run in the code sandbox (sandbox.js): run_python, and
// read_structure_file (gemmi) for MTZ, mmCIF, PDB and map files. Files of the
// chat are handed in read-only; what the code saves in /work/out comes back as
// new files in the chat (charts as images).
const path = require('path');
const storage = require('./storage');
const sandbox = require('./sandbox');

const MAX_INPUT_BYTES = 200 * 1024 * 1024;

// gemmi summary of one file, as JSON on stdout (also used for MTZ uploads).
const GEMMI_SCRIPT = `
import json, sys, gemmi
p = sys.argv[1] if len(sys.argv) > 1 else FILE
out = {"file": p.split("/")[-1], "gemmi": gemmi.__version__}
def cell(c): return {"a": round(c.a, 3), "b": round(c.b, 3), "c": round(c.c, 3), "alpha": round(c.alpha, 2), "beta": round(c.beta, 2), "gamma": round(c.gamma, 2)}
low = p.lower()
with open(p, "rb") as fh: head = fh.read(4)
try:
    if head == b"MTZ ":
        m = gemmi.read_mtz_file(p)
        out.update(type="MTZ reflection file", spacegroup=m.spacegroup.hm if m.spacegroup else None, cell=cell(m.cell),
                   resolution_high=round(m.resolution_high(), 3), resolution_low=round(m.resolution_low(), 3), reflections=m.nreflections,
                   title=m.title, columns=[{"label": c.label, "type": c.type, "dataset": c.dataset_id} for c in m.columns],
                   datasets=[{"id": d.id, "project": d.project_name, "crystal": d.crystal_name, "dataset": d.dataset_name, "wavelength": round(d.wavelength, 5)} for d in m.datasets])
    elif low.endswith((".ccp4", ".map", ".mrc")):
        g = gemmi.read_ccp4_map(p, setup=False)
        out.update(type="density map", cell=cell(g.grid.unit_cell), grid=[g.header_i32(1), g.header_i32(2), g.header_i32(3)], spacegroup=g.grid.spacegroup.hm if g.grid.spacegroup else None)
    else:
        st = gemmi.read_structure(p)
        st.setup_entities()
        info = {}
        if low.endswith((".cif", ".mmcif")) or head[:4] == b"data":
            try:
                block = gemmi.cif.read(p).sole_block()
                for tag in ["_refine.ls_d_res_high", "_refine.ls_R_factor_R_work", "_refine.ls_R_factor_R_free", "_refine.ls_R_factor_obs",
                            "_exptl.method", "_struct.title", "_reflns.d_resolution_high", "_em_3d_reconstruction.resolution", "_pdbx_database_status.recvd_initial_deposition_date"]:
                    v = block.find_value(tag)
                    if v not in (None, "?", "."): info[tag] = gemmi.cif.as_string(v)
            except Exception as e:
                info["cif_note"] = str(e)[:200]
        else:
            for line in open(p, errors="replace"):
                if line.startswith("REMARK   3   R VALUE") or line.startswith("REMARK   3   FREE R VALUE  ") or line.startswith("EXPDTA") or line.startswith("TITLE"):
                    info.setdefault("header", []).append(line.rstrip()[:100])
        polymer_chains, ligands, waters = [], {}, 0
        for model in ([st[0]] if len(st) else []):
            for ch in model:
                pol = ch.get_polymer()
                if len(pol): polymer_chains.append({"chain": ch.name, "residues": len(pol), "type": str(pol.check_polymer_type()).split(".")[-1]})
                for r in ch.get_ligands(): ligands[r.name] = ligands.get(r.name, 0) + 1
                waters += len(ch.get_waters())
        out.update(type="structure (" + ("mmCIF" if st.input_format == gemmi.CoorFormat.Mmcif else "PDB") + ")", name=st.name,
                   spacegroup=st.spacegroup_hm or None, cell=cell(st.cell), resolution=round(st.resolution, 3) if st.resolution else None,
                   models=len(st), chains=polymer_chains, ligands=ligands, waters=waters,
                   entities=[{"name": e.name, "type": str(e.entity_type).split(".")[-1], "chains": list(e.subchains)[:20]} for e in st.entities][:30],
                   header=info)
except Exception as e:
    out["error"] = type(e).__name__ + ": " + str(e)[:300]
print(json.dumps(out))
`;

// The text an MTZ upload keeps (so the model sees it in later questions).
async function mtzSummary(src, name) {
  const r = await sandbox.run({ code: `FILE = ${JSON.stringify(`/work/in/${sandbox.safeName(name)}`)}\n${GEMMI_SCRIPT}`, inputs: [{ name, src }], timeoutS: 30 });
  if (r.exitCode !== 0) throw new Error('the MTZ file could not be read');
  const data = JSON.parse(r.stdout.split('\n').pop());
  if (data.error) throw new Error(data.error);
  return `MTZ reflection file ${name} (read with gemmi ${data.gemmi}).\nSpace group: ${data.spacegroup}\nCell: ${JSON.stringify(data.cell)}\n`
    + `Resolution: ${data.resolution_low} to ${data.resolution_high} Å, ${data.reflections} reflections\nTitle: ${data.title || '-'}\n`
    + `Datasets: ${data.datasets.map(d => `${d.project}/${d.crystal}/${d.dataset} (wavelength ${d.wavelength})`).join('; ')}\n`
    + `Columns: ${data.columns.map(c => `${c.label} (${c.type})`).join(', ')}`;
}

// The chat files a tool may hand in: attached or made earlier, newest per name.
function chatFiles(ctx) {
  const refs = new Map();
  for (const m of ctx.history) for (const f of m.files || []) refs.set(f.name, f);
  for (const f of ctx.created) refs.set(f.name, f);
  return refs;
}

async function inputsFor(ctx, names) {
  const refs = chatFiles(ctx);
  const list = [];
  let total = 0;
  for (const wanted of names) {
    const name = [...refs.keys()].find(n => n === wanted) || [...refs.keys()].find(n => n.toLowerCase() === String(wanted).toLowerCase());
    if (!name) throw new Error(`there is no file "${String(wanted).slice(0, 80)}" in this chat; files: ${[...refs.keys()].join(', ') || 'none'}`);
    const meta = await storage.getFileMeta(ctx.root, ctx.chatId, refs.get(name).id);
    total += meta.bytes;
    if (total > MAX_INPUT_BYTES) throw new Error('the files are too large for the sandbox together (200 MB at most)');
    list.push({ name, src: storage.filePath(ctx.root, ctx.chatId, meta) });
  }
  return list;
}

async function saveOutputs(ctx, outputs) {
  const fileTools = require('./fileTools'); // lazily: fileTools -> files -> sandboxTools
  const saved = [];
  const failed = [];
  for (const o of outputs) {
    try {
      saved.push((await fileTools.storeData(ctx, o.name, o.data)).name);
    } catch (err) {
      failed.push(`${o.name} (${err.message})`);
    }
  }
  return { saved, failed };
}

const TOOLS = [
  {
    key: 'run_python',
    name: 'Run Python (code sandbox)',
    what: 'Lets the AI run Python code to calculate, analyse data or make charts, with numpy, scipy, pandas, matplotlib, biopython, gemmi and rdkit. Charts and other results come back as files in the chat.',
    example: 'Plot the absorbance values in this CSV and fit a line.',
    sees: 'Only the chat files the AI hands in (read-only), in an isolated sandbox with no network, no other files and limits on memory, processes and time.',
    risk: 'makes new files',
    status: 'tested',
    definition: {
      name: 'run_python',
      description: 'Runs a Python 3 program in an isolated sandbox (no internet; 60 s; 2 GB memory). Available: numpy, scipy, pandas, matplotlib, biopython, gemmi, rdkit. '
        + 'Files of this chat named in "files" are at /work/in/<name> (read-only). Save charts and result files to /work/out/ (for example plt.savefig("/work/out/plot.png", dpi=150)); '
        + 'they are given to the person as files. Print the results you need; stdout and stderr come back to you.',
      parameters: {
        type: 'object',
        properties: {
          code: { type: 'string', description: 'The complete Python program' },
          files: { type: 'array', items: { type: 'string' }, description: 'Names of chat files the program needs' }
        },
        required: ['code']
      }
    },
    run: async (args, ctx) => {
      const code = String(args.code || '');
      if (!code.trim()) throw new Error('the program is empty');
      if (code.length > 100000) throw new Error('the program is too long');
      const inputs = await inputsFor(ctx, Array.isArray(args.files) ? args.files.slice(0, 10) : []);
      const r = await sandbox.run({ code, inputs });
      const { saved, failed } = await saveOutputs(ctx, r.outputs);
      return [
        `Exit: ${r.timedOut ? 'stopped after the time limit' : r.exitCode === 0 ? 'finished' : `ended with ${r.exitCode}${r.exitCode === 143 || r.exitCode === 'SIGKILL' ? ' (killed: memory or time limit)' : ''}`}.`,
        r.stdout ? `stdout:\n${r.stdout.slice(-8000)}` : 'stdout: (empty)',
        r.stderr ? `stderr:\n${r.stderr.slice(-3000)}` : '',
        saved.length ? `Files given to the person: ${saved.join(', ')}.` : '',
        failed.length ? `Files not saved: ${failed.join('; ')}.` : ''
      ].filter(Boolean).join('\n');
    }
  },
  {
    key: 'read_structure_file',
    name: 'Read structure and reflection files (gemmi)',
    what: 'Lets the AI read MTZ reflection files, mmCIF and PDB coordinate files and CCP4/MRC maps attached to the chat: cell, space group, resolution, R factors, chains, ligands, columns.',
    example: 'What is the space group and resolution of this MTZ? What ligands are in this model?',
    sees: 'Only the chat file it is asked to read, in the isolated sandbox.',
    risk: 'reads only',
    status: 'tested',
    definition: {
      name: 'read_structure_file',
      description: 'Reads an MTZ, mmCIF, PDB or CCP4/MRC map file attached to this chat with gemmi and returns a summary: type, space group, cell, resolution, R factors (mmCIF/PDB header), chains, ligands, waters, MTZ columns and datasets.',
      parameters: { type: 'object', properties: { file: { type: 'string', description: 'The file name' } }, required: ['file'] }
    },
    run: async (args, ctx) => {
      const [input] = await inputsFor(ctx, [args.file]);
      const name = path.basename(input.name);
      const r = await sandbox.run({ code: `FILE = ${JSON.stringify(`/work/in/${sandbox.safeName(name)}`)}\n${GEMMI_SCRIPT}`, inputs: [input], timeoutS: 60 });
      if (r.exitCode !== 0 || !r.stdout) throw new Error(`gemmi could not read ${name}${r.stderr ? `: ${r.stderr.split('\n').pop().slice(0, 300)}` : ''}`);
      const line = r.stdout.split('\n').pop();
      let data;
      try { data = JSON.parse(line); } catch (err) { throw new Error(`gemmi could not read ${name}`); }
      if (data.error) throw new Error(`gemmi could not read ${name}: ${data.error}`);
      return `gemmi summary of ${name}:\n${line}`;
    }
  }
];

module.exports = { TOOLS, mtzSummary, GEMMI_SCRIPT };
