import { z } from "zod";
const count = z.number().int().min(0).max(10000);
// Numeric, owner-only process telemetry. Never include identities or source content.
export const workflowProgressSchema = z.strictObject({
  fullyVerifiedPeople: count.optional(),
  verificationTarget: z.number().int().min(1).max(200).optional(),
  verificationCheckedAt: z.iso.datetime().optional(),
  verificationAvailable: z.boolean().optional(),
  peopleSaved: count,
  target: z.number().int().min(1).max(200),
  datasetPeople: count.optional(),
  datasetTarget: z.number().int().min(1).max(200).optional(),
  crmPeople: count.optional(),
  pagesProcessed: count,
  queued: count,
  failures: count,
  skipped: count,
  measuredAt: z.iso.datetime(),
  crmCheckedAt: z.iso.datetime().optional(),
});
export type WorkflowProgress = z.infer<typeof workflowProgressSchema>;
export function researchWorkflowProgress(job: any): WorkflowProgress {
  return workflowProgressSchema.parse({
    ...(job.verificationTarget
      ? {
          verificationTarget: job.verificationTarget,
          ...job.verificationProgress,
        }
      : {}),
    peopleSaved: job.added,
    target: job.input.target,
    ...(job.crmProgress
      ? {
          datasetPeople: job.crmProgress.researchPeople,
          crmPeople: job.crmProgress.crmPeople,
          crmCheckedAt: job.crmProgress.checkedAt,
        }
      : {}),
    ...(job.totalPeopleTarget ? { datasetTarget: job.totalPeopleTarget } : {}),
    pagesProcessed: job.done.length,
    queued: job.queue.length,
    failures: job.failures.length,
    skipped: job.skipped,
    measuredAt: job.updatedAt,
  });
}
