import { z } from "zod";
// Evaluate before any browser schemas are constructed. Runtime code generation
// is unnecessary and would violate the hosted page's strict script policy.
z.config({ jitless: true });
