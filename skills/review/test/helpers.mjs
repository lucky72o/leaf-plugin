import path from 'node:path';
import { fileURLToPath } from 'node:url';

/// The plugin root: test dir, review, skills, root.
export const repoRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../../..');
