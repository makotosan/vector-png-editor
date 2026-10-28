// Production normalization dependency (Issue #47 follow-up).
//
// The Core `normalize` command takes file paths and a report path,
// which the protocol-1 transport cannot express over a source buffer,
// so - like `validate --profile` and `convert` in coreExport.ts - it
// runs through the Core's versioned JSON CLI under the same bounded,
// shell-free spawn. The current source (unsaved edits included) is
// written to a private temp file; the normalized output and the
// conversion report are read back from temp locations only. Nothing
// outside the temp directory is written by this module.
import { mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { ExportUnavailableError } from './export.ts';
import { runCoreCli, warningsFromReport } from './coreExport.ts';
import type { NormalizeCoreOutcome, NormalizeSummary } from './normalize.ts';

const PYTHON_HINT = 'Normalize needs the Python Core: run the command “Vector PNG: Set Up Python Environment” or set "vectorPng.corePythonPath" to a Python 3.11-3.13 with the Core installed. Nothing was changed.';

type Report = Record<string, unknown>;

function record(value: unknown): Report | undefined {
  return typeof value === 'object' && value !== null && !Array.isArray(value) ? value as Report : undefined;
}

function count(report: Report | undefined, key: string): number {
  const changes = record(report?.changes);
  const value = changes?.[key];
  return typeof value === 'number' && Number.isFinite(value) ? value : 0;
}

export function summaryFromReport(report: Report | undefined): NormalizeSummary {
  const migrations: string[] = [];
  const accessibility = report?.accessibility;
  if (Array.isArray(accessibility)) {
    for (const entry of accessibility) {
      const item = record(entry);
      if (item && typeof item.attribute === 'string' && typeof item.target === 'string')
        migrations.push(`${item.attribute} -> ${item.target}`);
    }
  }
  return {
    appliedDeclarations: count(report, 'applied_declarations'),
    expandedMarkers: count(report, 'expanded_markers'),
    styleElements: count(report, 'style_elements'),
    classAttributes: count(report, 'class_attributes'),
    inlineStyles: count(report, 'inline_styles'),
    migrations,
    losses: warningsFromReport(report),
  };
}

export function errorsFromReport(report: Report | undefined): string[] {
  const errors = report?.errors;
  if (!Array.isArray(errors)) return [];
  const lines: string[] = [];
  for (const entry of errors) {
    const item = record(entry);
    if (!item) continue;
    const code = typeof item.code === 'string' ? item.code : 'unknown';
    const stage = typeof item.stage === 'string' ? ` (${item.stage})` : '';
    const explanation = typeof item.explanation === 'string' ? item.explanation : 'Normalization failed';
    lines.push(`${code}${stage}: ${explanation}`);
  }
  return lines;
}

let sequence = 0;

export function createCoreNormalizeDeps(pythonPath: string | undefined): {
  normalize: (source: string) => Promise<NormalizeCoreOutcome>;
} {
  return {
    async normalize(source: string): Promise<NormalizeCoreOutcome> {
      const python = pythonPath?.trim();
      if (!python) throw new ExportUnavailableError(PYTHON_HINT);
      const dir = await mkdtemp(join(tmpdir(), 'vpe-normalize-'));
      try {
        const input = join(dir, 'input.svg');
        const output = join(dir, 'output.svg');
        const reportPath = join(dir, 'report.json');
        await writeFile(input, source, 'utf8');
        const envelope = await runCoreCli(python, [
          '--request-id', `normalize-${Date.now()}-${++sequence}`,
          'normalize', input, output, '--report', reportPath,
        ]);
        if (!envelope.ok) {
          const details = record(envelope.error?.details);
          return {
            ok: false,
            code: envelope.error?.code ?? 'unknown',
            message: envelope.error?.message ?? 'The Core rejected the source',
            errors: errorsFromReport(record(details?.report)),
          };
        }
        const text = await readFile(output, 'utf8');
        let report = record(envelope.result);
        if (!report) {
          try { report = record(JSON.parse(await readFile(reportPath, 'utf8'))); } catch { report = undefined; }
        }
        return { ok: true, output: text, summary: summaryFromReport(report) };
      } finally {
        await rm(dir, { recursive: true, force: true }).catch(() => undefined);
      }
    },
  };
}
