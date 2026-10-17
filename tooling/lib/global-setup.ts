import { rmSync } from 'node:fs';
import { RAW_COVERAGE_DIR } from './test';

/** Start every e2e run with an empty raw-coverage folder so the merged numbers describe this run only. */
export default function globalSetup() {
  rmSync(RAW_COVERAGE_DIR, { recursive: true, force: true });
}
