// The starter set of benchmark questions, stored in ai_benchmark_prompts the
// first time the Benchmark tab is opened. Editable afterwards.
// check: a regular expression (case-insensitive) the answer must match, or null
// when a person scores the answer.

const SUMMARY_TEXT = 'Protein crystallography needs well-ordered crystals. A purified protein is concentrated, usually to between 5 and 20 mg/ml, and mixed with hundreds of different solutions in drops of about 100 nanolitres. Most drops give nothing, or an amorphous precipitate. Conditions that give small crystals are optimised by changing the pH, the precipitant concentration and the temperature. The best crystals are cooled in liquid nitrogen, with a cryoprotectant such as glycerol to prevent ice, and measured at a synchrotron. The diffraction images give intensities but not phases, so the phases come from a similar known structure (molecular replacement) or from heavy atoms. In recent years predicted models have made molecular replacement possible for most proteins.';

const STARTER = [
  { title: 'General knowledge', kind: 'text', prompt: 'Which element has the atomic number 26? Answer with the name only.', check: '\\biron\\b' },
  { title: 'Arithmetic', kind: 'text', prompt: 'What is 47 * 38 - 129? Give only the number.', check: '1[, ]?657' },
  { title: 'Reasoning', kind: 'text', prompt: 'Anna is older than Ben. Ben is older than Cleo. Dan is younger than Cleo. Who is the second oldest? Answer with the name only.', check: '\\bben\\b' },
  { title: 'Word problem', kind: 'text', prompt: 'A stock solution is 500 mM. How many microlitres of it are needed to make 2 ml of a 20 mM solution? Give only the number of microlitres.', check: '\\b80\\b' },
  { title: 'Coding', kind: 'text', prompt: 'In Python, what does this print?\nprint([x*x for x in range(6) if x % 2])\nGive only the output.', check: '\\[\\s*1\\s*,\\s*9\\s*,\\s*25\\s*\\]' },
  { title: 'Follow a format', kind: 'text', prompt: 'List the three primary colours of light as a JSON array of lowercase English words, and write nothing else.', check: '^\\s*(```(json)?\\s*)?\\[\\s*"(red|green|blue)"\\s*,\\s*"(red|green|blue)"\\s*,\\s*"(red|green|blue)"\\s*\\]\\s*(```)?\\s*$' },
  { title: 'Structural biology', kind: 'text', prompt: 'Explain to a new PhD student, in about 120 words, why phases are needed to calculate an electron density map and two ways to get them.', check: null },
  { title: 'Summary', kind: 'text', prompt: `Summarise this text in two sentences:\n\n${SUMMARY_TEXT}`, check: null },
  { title: 'Image', kind: 'image', prompt: 'Describe the two shapes in this image from left to right, with their colours, in one line.', check: '(red[^.]*(circle|disc|disk|dot)|(circle|disc|disk|dot)[^.]*red)[\\s\\S]*(blue[^.]*(square|rectangle)|(square|rectangle)[^.]*blue)' },
  { title: 'Long text recall', kind: 'long', prompt: 'What is the storage code of sample 417 in the list? Give only the code.', check: 'KESTREL-58' }
];

// About 20,000 tokens of numbered lines with one fact hidden in the middle.
function longText() {
  const lines = [];
  for (let i = 1; i <= 800; i++) {
    lines.push(i === 417 ? 'Sample 417: storage code KESTREL-58, freezer C, box 12.'
      : `Sample ${i}: storage code ${['HERON', 'FINCH', 'RAVEN', 'SWIFT', 'EGRET'][i % 5]}-${(i * 37) % 97}, freezer ${'ABCD'[i % 4]}, box ${(i * 7) % 40}.`);
  }
  return lines.join('\n');
}

const IMAGE_SVG = '<svg xmlns="http://www.w3.org/2000/svg" width="640" height="320"><rect width="640" height="320" fill="white"/><circle cx="170" cy="160" r="110" fill="#d00000"/><rect x="370" y="50" width="220" height="220" fill="#0000d0"/></svg>';

module.exports = { STARTER, longText, IMAGE_SVG };
