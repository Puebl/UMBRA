import { join } from 'node:path';

export const artifactPath = (name: string) => join(process.env.E2E_ARTIFACT_DIR ?? 'artifacts', name);
