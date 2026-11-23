# TypeScript port bootstrap profile

## Source and authority
- Source repo: `D:\source\LLMContextLib`
- Source baseline commit: `479d2612315cbd292da917bae6d8d3fec35fea24`
- Canonical planning files: `D:\source\polymorhic\llmcontextlibport\porting.md`, `D:\source\polymorhic\llmcontextlibport\scaffold.md`
- Read-only reference checkout: `D:\source\LLMContextLib`

## Destination
- Implementation repository: same Git repository as the source, with an additive port layout
- Worktree: `D:\source\LLMContextLib-Ts`
- Branch: `port/typescript`
- Port root: `D:\source\LLMContextLib-Ts\ports\typescript`
- Output/evidence: worktree-local `ports/typescript` and node_modules from npm install

## Selected language/runtime
- Language: TypeScript / Node.js
- Runtime: Node.js 22 LTS
- Compiler: TypeScript 5.7.x (strict mode)
- Module system: ESM (`type: "module"`)
- Supported profile: current host runtime only; no claim for unsupported Node versions or browsers

## Build and package
- Build system: npm workspaces with a dedicated package for the port
- Package layout: `ports/typescript/{src,tests}` with additive `ports/conformance` only as required
- Dependency pins: installed from npm at bootstrap time; no lockfile was created as part of this initial bootstrap but the exact package versions are recorded in `package.json`
- Commands: `npm install`, `npm run build`, `npm test`

## API and runtime contract decisions
- Public surface is modeled as interface-driven modules, immutable value objects, and explicit error objects; no silent coercion of user-supplied values
- Integer semantics preserve exact values through bigint for high-range counters and explicit checked arithmetic in port code; JavaScript Number remains explicitly treated as a risk area for parity work
- Text semantics are normalized to UTF-16 code-unit handling in the port-specific bootstrap probe, with ordinal comparison as the required contract baseline
- Concurrency and lifecycle are modeled as explicit async scheduling with shutdown/join semantics; synchronous admission behavior is a parity risk and remains a blocker until implementation-level evidence exists

## Testing and differential evidence
- Bootstrap test framework: Vitest + tsx
- Initial parity probes focus on exact integer handling and UTF-16 behavior before any production implementation
- Independent source oracle remains the read-only C# implementation in `D:\source\LLMContextLib`

## Bootstrap gate status
- Gate result: PASS for toolchain/bootstrap readiness
- Remaining blockers: full implementation parity, exact session/index ownership semantics, mutable/immutable publication invariants, and complete adapter/benchmark parity remain explicitly unimplemented and require implementation work packets
