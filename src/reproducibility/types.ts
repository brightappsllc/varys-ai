export type ReproSeverity = 'critical' | 'warning' | 'info';

export interface ReproIssue {
  id:              string;
  rule_id:         string;
  severity:        ReproSeverity;
  cell_index:      number;
  title:           string;
  message:         string;
  explanation:     string;
  suggestion:      string;
  fix_code:        string | null;
  fix_description: string | null;
  /** Populated when loaded from the DB */
  notebook_path?:  string;
  detected_at?:    string;
}
