import { mkdir, readFile, writeFile } from 'node:fs/promises';
import { dirname, resolve } from 'node:path';
import { generatedDatasetToCsv, generateSyntheticGradebook, type DataGenerationPlan, type EvaluationDefinition, type GradingDefinition } from '@apms/domain';

type Input = { gradingSystem?: GradingDefinition; gradingSystemFile?: string; evaluationSystem?: EvaluationDefinition; evaluationSystemFile?: string; plan: DataGenerationPlan };

async function main() {
  const [, , inputPath, outputPath = 'generated-gradebook-data'] = process.argv;
  if (!inputPath || inputPath === '--help' || inputPath === '-h') {
    process.stdout.write('Usage: npm run generate:data -- <input.json> [output-directory]\n\nInput JSON must contain gradingSystem, plan, and optionally evaluationSystem.\n');
    return;
  }
  const absoluteInput = resolve(inputPath);
  const input = JSON.parse(await readFile(absoluteInput, 'utf8')) as Input;
  if (!input.plan) throw new Error('Input JSON must contain plan.');
  const resolveInputFile = async (path?: string) => path ? JSON.parse(await readFile(resolve(dirname(absoluteInput), path), 'utf8')) : undefined;
  const gradingSystem = input.gradingSystem ?? await resolveInputFile(input.gradingSystemFile);
  const evaluationSystem = input.evaluationSystem ?? await resolveInputFile(input.evaluationSystemFile);
  if (!gradingSystem) throw new Error('Input JSON must contain gradingSystem or gradingSystemFile.');
  const dataset = generateSyntheticGradebook(gradingSystem, input.plan, evaluationSystem);
  const directory = resolve(outputPath);
  await mkdir(directory, { recursive: true });
  await Promise.all([
    writeFile(resolve(directory, 'dataset.json'), `${JSON.stringify(dataset, null, 2)}\n`, 'utf8'),
    ...(['students', 'assessments', 'results', 'summaries'] as const).map((table) => writeFile(resolve(directory, `${table}.csv`), `${generatedDatasetToCsv(dataset, table)}\r\n`, 'utf8')),
    writeFile(resolve(directory, 'manifest.json'), `${JSON.stringify({ generatedAt: new Date().toISOString(), seed: dataset.seed, batchId: dataset.batchId, counts: dataset.counts, gradingSystemId: gradingSystem.id, gradingSystemName: gradingSystem.name, evaluationSystemId: evaluationSystem?.id ?? null }, null, 2)}\n`, 'utf8'),
  ]);
  process.stdout.write(`Generated ${dataset.counts.students} students, ${dataset.counts.assessments} assessments, and ${dataset.counts.results} results in ${directory}.\n`);
  process.stdout.write(`Status preview: ${dataset.counts.pass} pass, ${dataset.counts.fail} fail, ${dataset.counts.incomplete} incomplete.\n`);
}


main().catch((cause: unknown) => {
  process.stderr.write(`${cause instanceof Error ? cause.message : String(cause)}\n`);
  process.exitCode = 1;
});
