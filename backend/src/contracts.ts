export type Operation = "CLICK" | "INPUT" | "SELECT" | "SCROLL";
export type TaskStatus = "running" | "done" | "failed" | "stopped";

export interface Candidate {
  backendNodeId: number;
  role: string;
  name: string;
  formattedValue: string;
  inputType?: string;
  inputState?: "empty" | "populated" | "checked";
  required?: boolean;
  valueAvailable?: boolean;
  frameId?: string;
  href?: string;
  nearbyHeading?: string;
}

export interface LayaDecision {
  taskId: string;
  backendNodeId: number | null;
  operation: Operation | null;
  targetConfidence: number;
  goalMet: boolean;
  goalMetConfidence: number;
  stuck: boolean;
  stuckConfidence: number;
  probabilities: Record<string, number>;
  rationale: string;
}

export interface StepRecord {
  step: number;
  at: string;
  url: string;
  candidates: Candidate[];
  decision: LayaDecision | null;
  action: { operation: Operation; backendNodeId: number; target: string; value?: string } | null;
  result: string;
  verified: boolean;
}

export interface TaskVerification {
  textIncludes?: string;
  urlIncludes?: string;
}

export interface StructuredTask {
  from?: string;
  to?: string;
  date?: string;
  search?: string;
  values?: Record<string, string>;
  verify?: TaskVerification;
}

export interface RunTaskRequest {
  url: string;
  goal: string;
  task?: StructuredTask;
}

export interface TaskRecord {
  taskId: string;
  status: TaskStatus;
  goal: string;
  history: StepRecord[];
  error?: string;
  stopRequested: boolean;
  startedAt: string;
  completedAt?: string;
}

export interface LayaRequest {
  taskId: string;
  goal: string;
  state: { url: string; title: string; pageText: string };
  components: Candidate[];
  history: Array<{ step: number; target: string; operation: Operation | null; result: string }>;
}

export interface LayaResponse extends LayaDecision {}
