import {
  mailEvidenceResponse,
  type MailEvidence,
} from "../../modules/connectors/mail-evidence-contracts.js";
export type EvidenceView = {
  busy: boolean;
  selected: string | null;
  evidence: MailEvidence | null;
  unavailable: boolean;
};
type Api = (path: string, method?: string, body?: unknown) => Promise<unknown>;
const empty = (): EvidenceView => ({
  busy: false,
  selected: null,
  evidence: null,
  unavailable: false,
});
/** One visible passage, cleared on hide; late successes and failures cannot restore it. */
export class MailEvidenceState {
  private epoch = 0;
  private disposed = false;
  view = empty();
  constructor(
    private api: Api,
    private taskId: string,
    private revision: number,
    private changed: (view: EvidenceView) => void,
  ) {}
  private publish(view: EvidenceView) {
    this.view = view;
    this.changed(view);
  }
  hide() {
    this.epoch++;
    if (!this.disposed) this.publish(empty());
  }
  dispose() {
    this.epoch++;
    this.disposed = true;
    this.view = empty();
  }
  async open(sectionId: string) {
    if (this.disposed) return;
    const epoch = ++this.epoch;
    this.publish({ ...empty(), busy: true, selected: sectionId });
    try {
      const response = await this.api(
        "/v1/requests/" + encodeURIComponent(this.taskId) + "/mail-evidence",
        "POST",
        { expectedRevision: this.revision, sectionId },
      );
      if (this.disposed || epoch !== this.epoch) return;
      const evidence = mailEvidenceResponse.parse(response);
      if (
        evidence.taskId !== this.taskId ||
        evidence.taskRevision !== this.revision ||
        evidence.sectionId !== sectionId
      )
        throw Error("Unavailable");
      this.publish({
        busy: false,
        selected: sectionId,
        evidence,
        unavailable: false,
      });
    } catch {
      if (!this.disposed && epoch === this.epoch)
        this.publish({ ...empty(), unavailable: true });
    }
  }
}
