// User Python discovery for the managed environment (P2-07),
// framework-free. Discovery only reads: it runs each candidate with
// `-I -c` to report its version and absolute executable path, and
// never installs, creates or modifies anything. The first candidate
// inside the supported range (3.11-3.13, the bridge manager's policy)
// wins; everything found is reported so the UI can explain a miss.
export type PythonCandidate = { command: string; args: string[] };
export type ProbeResult = { executable: string; version: [number, number, number] };
export type Probe = (candidate: PythonCandidate) => Promise<ProbeResult | undefined>;
export type Discovery = {
  selected?: ProbeResult & { via: string };
  unsupported: (ProbeResult & { via: string })[];
  probed: number;
};

export function pythonCandidates(platform: string): PythonCandidate[] {
  if (platform === 'win32') {
    return [
      { command: 'py', args: ['-3.13'] }, { command: 'py', args: ['-3.12'] }, { command: 'py', args: ['-3.11'] },
      { command: 'py', args: ['-3'] },
      { command: 'python', args: [] }, { command: 'python3', args: [] },
    ];
  }
  return [
    { command: 'python3.13', args: [] }, { command: 'python3.12', args: [] }, { command: 'python3.11', args: [] },
    { command: 'python3', args: [] }, { command: 'python', args: [] },
  ];
}

export function isSupported(version: [number, number, number]): boolean {
  return version[0] === 3 && version[1] >= 11 && version[1] <= 13;
}

export async function discoverPython(probe: Probe, platform: string): Promise<Discovery> {
  const unsupported: Discovery['unsupported'] = [];
  let probed = 0;
  for (const candidate of pythonCandidates(platform)) {
    probed += 1;
    const result = await probe(candidate).catch(() => undefined);
    if (!result) continue;
    const via = [candidate.command, ...candidate.args].join(' ');
    if (isSupported(result.version)) return { selected: { ...result, via }, unsupported, probed };
    unsupported.push({ ...result, via });
  }
  return { unsupported, probed };
}

// The probe script: version triple plus the resolved absolute path of
// the interpreter (a launcher like `py` reports the real executable).
export const PROBE_SCRIPT = 'import json,sys;print(json.dumps({"version":list(sys.version_info[:3]),"executable":sys.executable}))';

export function parseProbeOutput(stdout: string): ProbeResult | undefined {
  try {
    const value = JSON.parse(stdout.trim()) as { version?: unknown; executable?: unknown };
    if (!Array.isArray(value.version) || value.version.length !== 3
        || value.version.some((n) => !Number.isInteger(n) || (n as number) < 0)
        || typeof value.executable !== 'string' || value.executable.length === 0) return undefined;
    return { version: value.version as [number, number, number], executable: value.executable };
  } catch { return undefined; }
}
