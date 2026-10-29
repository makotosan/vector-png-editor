// Production normalization dependency (Issue #47 follow-up; TS Core
// switch in Issue #59).
//
// Normalization now runs in-process through the TypeScript Core
// (packages/ts-core): normalizeDocument is the port of the Python
// Core's gated entry point, with the before/after render gate on
// resvg. The current source (unsaved edits included) is normalized
// in memory and the conversion report is read from the result -
// nothing is written anywhere by this module; the caller applies
// the returned text as one undoable edit.
import {
  NormalizeRejection, normalizeDocument,
  type ConversionReport,
} from '../../ts-core/src/normalize.ts';
import { warningsFromReport } from './coreExport.ts';
import type { NormalizeCoreOutcome, NormalizeSummary } from './normalize.ts';
import type { TsCoreRuntime } from './tsCore.ts';

export function summaryFromReport(report: ConversionReport | undefined): NormalizeSummary {
  const migrations: string[] = [];
  if (report) {
    for (const item of report.accessibility) {
      if (typeof item.target === 'string') migrations.push(`${item.attribute} -> ${item.target}`);
    }
  }
  const changes = report?.changes;
  return {
    appliedDeclarations: changes?.applied_declarations ?? 0,
    expandedMarkers: changes?.expanded_markers ?? 0,
    styleElements: changes?.style_elements ?? 0,
    classAttributes: changes?.class_attributes ?? 0,
    inlineStyles: changes?.inline_styles ?? 0,
    migrations,
    losses: warningsFromReport(report),
  };
}

export function errorsFromReport(report: ConversionReport | undefined): string[] {
  if (!report) return [];
  return report.errors.map((item) => {
    const stage = item.stage ? ` (${item.stage})` : '';
    return `${item.code}${stage}: ${item.explanation}`;
  });
}

export function createCoreNormalizeDeps(runtime: TsCoreRuntime): {
  normalize: (source: string) => Promise<NormalizeCoreOutcome>;
} {
  return {
    async normalize(source: string): Promise<NormalizeCoreOutcome> {
      const { fonts, defaultFamily } = await runtime.fonts;
      try {
        const { output, report } = await normalizeDocument(Buffer.from(source, 'utf8'), {
          fonts, defaultFontFamily: defaultFamily, sansSerifFamily: defaultFamily,
        });
        return {
          ok: true,
          output: new TextDecoder('utf-8').decode(output),
          summary: summaryFromReport(report),
        };
      } catch (error) {
        if (error instanceof NormalizeRejection) {
          return {
            ok: false,
            code: error.code,
            message: error.message,
            errors: errorsFromReport(error.report),
          };
        }
        throw error;
      }
    },
  };
}
