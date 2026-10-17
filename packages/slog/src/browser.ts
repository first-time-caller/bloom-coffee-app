import { parseShot, parseIndex, shotToCurve, summarizeShot, slogPath, SlogError } from './index.ts';
(globalThis as any).BloomSlog = { parseShot, parseIndex, shotToCurve, summarizeShot, slogPath, SlogError };
